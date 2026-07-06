/**
 * 飞书机器人桥接模块
 *
 * 职责：
 *  - 通过「长连接」接收用户发给机器人的消息（im.message.receive_v1）
 *  - 通过 API 主动推送「反馈请求」交互卡片
 *  - 维护「卡片 message_id ↔ requestId」映射，支持用户「回复某条卡片」时精确路由
 *
 * 设计要点：
 *  - 飞书 SDK 用动态 import 按需加载：用户没配置飞书时，这个重依赖根本不会被 require，零开销。
 *  - 本模块只封装「飞书侧能力 + 映射表」，不掺杂业务路由决策；
 *    路由（resolve 哪个 pending / 是否跨实例转发）由 mcp-server 通过注入的回调处理。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileLog } from './logger.js';

function flog(message: string) {
  console.error(`[${new Date().toISOString()}] [feishu] ${message}`);
  fileLog('feishu', message);
}

export interface FeishuConfig {
  appId: string;
  appSecret: string;
  /** 通知开关：false 时不向飞书推送卡片（长连接仍保留，便于绑定/回复） */
  enabled?: boolean;
  /** Get 表情轻回执开关：false 时用户回复后不加 Get 表情、也不发文字兜底回执 */
  ackReaction?: boolean;
  /** 忙时消息排队开关：AI 正忙（无等待中的请求）时把用户消息排队，下一轮 feedback 自动送达 */
  queueWhenBusy?: boolean;
  /** @deprecated 绑定改为磁盘共享文件，不再通过配置传递 */
  boundChatId?: string;
}

export interface FeishuInboundImage {
  /** 文件名（含后缀） */
  name: string;
  /** base64 编码的图片数据（不含 data: 前缀） */
  data: string;
  /** 字节大小 */
  size: number;
}

export interface FeishuInboundReply {
  /** 用户回复所针对的卡片 message_id（飞书 parent_id）；直接发消息时为 null */
  parentId: string | null;
  /** 用户回复的纯文本内容（非文本消息会降级为占位说明） */
  text: string;
  /** 来源会话 id，用于回执 */
  chatId: string;
  /** 触发本次反馈的用户消息 id（合并组的最后一条），用于「表情回应」轻回执 */
  messageId?: string;
  /** 图片（base64，喂给 AI 的视觉通道）；可选 */
  images?: FeishuInboundImage[];
  /** 已落盘的文件绝对路径（文件 / 音频 / 视频）；可选 */
  files?: string[];
}

export interface FeishuStatus {
  configured: boolean;
  connected: boolean;
  enabled: boolean;
  ackReaction: boolean;
  queueWhenBusy: boolean;
  /** 当前生效的凭证（来自磁盘/env，供插件面板回显；本地 127.0.0.1 传输、无跨域风险） */
  appId: string;
  appSecret: string;
  boundChatId: string | null;
}

/** 「扫码一键创建应用」流程状态（Device Authorization Grant，见 SDK registerApp） */
export interface FeishuRegisterState {
  status: 'idle' | 'waiting' | 'success' | 'error';
  /** 待用户在飞书中打开/扫码的验证链接（waiting 时有值） */
  url?: string;
  /** 验证链接的二维码 data URL（server 侧生成：插件 VSIX 不带 node_modules，无法本地生成） */
  qr?: string;
  /** 链接有效期（秒） */
  expireIn?: number;
  /** 创建成功的 App ID（success 时有值；secret 不随状态下发，走常规凭证同步） */
  appId?: string;
  error?: string;
}

export class FeishuBridge {
  private lark: any = null;
  private client: any = null; // Lark.Client：调用 API 发消息
  private wsClient: any = null; // Lark.WSClient：长连接收事件
  private config: FeishuConfig | null = null;
  private connected = false;
  private enabled = true;
  /** Get 表情轻回执开关（false 时用户回复后不加表情、也不发文字兜底） */
  private ackReaction = true;
  /** 忙时消息排队开关（true 时 AI 正忙的消息入队等下一轮，false 走旧的短暂存 + 过期提示） */
  private queueWhenBusy = true;
  /** 绑定关系（appId -> chat_id）持久化到磁盘：多个 server 进程共享、reload 不丢 */
  private bindStorePath = path.join(os.homedir(), '.cursor-feedback', 'feishu-bind.json');
  /** 飞书凭证持久化到磁盘：多个 server 进程共享、reload/重启不丢，作为凭证的全局真相源 */
  private configStorePath = path.join(os.homedir(), '.cursor-feedback', 'feishu-config.json');

  // 卡片 message_id -> requestId（仅记录本实例发出的卡片）
  private cardToRequest = new Map<string, string>();
  // requestId -> 卡片 message_id（清理用）
  private requestToCard = new Map<string, string>();
  // requestId -> 归属项目空间：请求结束后仍保留（与卡片映射同生命周期），
  // 供「回复已结束的旧卡片 → 忙时排队到对应项目」定位归属，随 FIFO 上界一起淘汰
  private requestProjects = new Map<string, string>();
  // requestId -> 摘要信息（多窗口「列清单」提示用）
  private pendingSummaries = new Map<string, { summary: string; projectDir: string }>();

  /** 收到用户回复时的回调（由 mcp-server 注入，负责路由 / 转发） */
  private onReply: ((reply: FeishuInboundReply) => void) | null = null;
  /** 绑定的 chat_id 变化时的回调（由 mcp-server 注入，用于通知 extension 持久化） */
  private onBindChange: ((chatId: string) => void) | null = null;

  setOnReply(fn: (reply: FeishuInboundReply) => void) {
    this.onReply = fn;
  }
  setOnBindChange(fn: (chatId: string) => void) {
    this.onBindChange = fn;
  }

  getStatus(): FeishuStatus {
    return {
      configured: !!this.config,
      connected: this.connected,
      enabled: this.enabled,
      ackReaction: this.ackReaction,
      queueWhenBusy: this.queueWhenBusy,
      appId: this.config?.appId || '',
      appSecret: this.config?.appSecret || '',
      boundChatId: this.getBoundChatId(),
    };
  }

  isQueueWhenBusy(): boolean {
    return this.queueWhenBusy;
  }

  isConfigured(): boolean {
    return !!this.config;
  }

  // ---------- 扫码一键创建应用（registerApp / Device Grant） ----------
  private registerState: FeishuRegisterState = { status: 'idle' };
  private registerAbort: AbortController | null = null;

  getRegisterState(): FeishuRegisterState {
    return this.registerState;
  }

  /**
   * 启动「扫码一键创建应用」：返回待扫码的验证链接（等 onQRCodeReady 就绪后才返回）。
   * 用户在飞书里确认后 SDK resolve 出凭证 → 与手动在面板保存等价（写磁盘 touched + configure 立即生效）。
   * 已有等待中的流程直接复用当前二维码，不重复发起。
   */
  async startRegister(): Promise<FeishuRegisterState> {
    if (this.registerState.status === 'waiting' && this.registerAbort) {
      return this.registerState;
    }
    if (!this.lark) {
      try {
        this.lark = await import('@larksuiteoapi/node-sdk');
      } catch (e) {
        flog('飞书 SDK 加载失败: ' + e);
        this.registerState = { status: 'error', error: 'sdk_load_failed' };
        return this.registerState;
      }
    }
    if (typeof this.lark.registerApp !== 'function') {
      this.registerState = { status: 'error', error: 'sdk_too_old' };
      return this.registerState;
    }

    const abort = new AbortController();
    this.registerAbort = abort;
    const state: FeishuRegisterState = { status: 'waiting' };
    this.registerState = state;

    let urlResolve: () => void = () => {};
    const urlReady = new Promise<void>((resolve) => {
      urlResolve = resolve;
      setTimeout(resolve, 10000); // 兜底：10s 拿不到二维码就按错误返回
    });

    this.lark
      .registerApp({
        signal: abort.signal,
        onQRCodeReady: (info: { url: string; expireIn: number }) => {
          state.url = info.url;
          state.expireIn = info.expireIn;
          urlResolve();
        },
        appPreset: {
          name: 'Cursor Feedback',
          desc: 'Cursor AI 交互反馈通知机器人（由 cursor-feedback 插件扫码创建）',
        },
        // 平台基础模板已含收发消息 / reaction / 长连接事件；这里增量补齐本插件用到的资源权限。
        // 平台不认识的名字会在确认页被静默丢弃，不会导致流程失败。
        addons: {
          scopes: { tenant: ['im:message', 'im:message:send_as_bot', 'im:resource'] },
          events: { items: { tenant: ['im.message.receive_v1'] } },
        },
        // 只允许创建新应用：避免用户误选已有应用、其配置被覆盖
        createOnly: true,
      })
      .then(async (result: { client_id: string; client_secret: string }) => {
        if (this.registerState !== state) return; // 已被取消/新流程覆盖
        const cfg: FeishuConfig = {
          appId: result.client_id,
          appSecret: result.client_secret,
          enabled: this.enabled,
          ackReaction: this.ackReaction,
          queueWhenBusy: this.queueWhenBusy,
        };
        this.writePersistedConfig({ ...cfg, touched: true });
        await this.configure(cfg);
        state.status = 'success';
        state.appId = result.client_id;
        state.url = undefined;
        flog(`扫码创建应用成功: ${result.client_id}`);
      })
      .catch((e: { code?: string; description?: string }) => {
        if (this.registerState !== state) return;
        state.status = 'error';
        state.url = undefined;
        state.error = [e?.code, e?.description].filter(Boolean).join(': ') || String(e);
        flog(`扫码创建应用失败: ${state.error}`);
      });

    await urlReady;
    if (state.status === 'waiting' && !state.url) {
      abort.abort();
      this.registerAbort = null;
      this.registerState = { status: 'error', error: 'qr_timeout' };
      return this.registerState;
    }
    // 二维码在 server 侧生成（插件 VSIX 不带 node_modules）；失败则面板退化为只显示链接按钮
    if (state.status === 'waiting' && state.url) {
      try {
        const QRCode = await import('qrcode');
        state.qr = await QRCode.toDataURL(state.url, { margin: 1, width: 220 });
      } catch (e) {
        flog('二维码生成失败（退化为链接）: ' + e);
      }
    }
    return this.registerState;
  }

  /** 取消进行中的扫码创建流程（用户关闭弹窗 / 主动取消） */
  cancelRegister(): void {
    if (this.registerAbort) {
      this.registerAbort.abort();
      this.registerAbort = null;
    }
    if (this.registerState.status === 'waiting') {
      this.registerState = { status: 'idle' };
    }
  }

  /** 读取当前 appId 对应的绑定 chat_id（来自磁盘，跨进程共享） */
  private getBoundChatId(): string | null {
    if (!this.config?.appId) return null;
    return this.readBindStore()[this.config.appId] || null;
  }

  /** 记录绑定（仅在变化时写盘，避免频繁 IO） */
  private setBoundChatId(chatId: string): void {
    if (!this.config?.appId) return;
    const store = this.readBindStore();
    if (store[this.config.appId] === chatId) return;
    store[this.config.appId] = chatId;
    this.writeBindStore(store);
    flog('已绑定接收方: ' + chatId);
  }

  /** 解除绑定（用户「删绑定」后可重新发消息绑定） */
  unbind(): void {
    const store = this.readBindStore();
    if (this.config?.appId) {
      delete store[this.config.appId];
    } else {
      for (const k of Object.keys(store)) delete store[k];
    }
    this.writeBindStore(store);
    flog('已解除绑定');
  }

  private readBindStore(): Record<string, string> {
    try {
      return JSON.parse(fs.readFileSync(this.bindStorePath, 'utf-8')) || {};
    } catch {
      return {};
    }
  }

  private writeBindStore(data: Record<string, string>): void {
    try {
      fs.mkdirSync(path.dirname(this.bindStorePath), { recursive: true });
      fs.writeFileSync(this.bindStorePath, JSON.stringify(data), 'utf-8');
    } catch (e) {
      flog('写绑定文件失败: ' + e);
    }
  }

  /** 读取持久化的飞书凭证（无文件返回 null）。touched=true 表示用户在面板主动配过（含主动清空）。 */
  readPersistedConfig(): (FeishuConfig & { touched?: boolean }) | null {
    try {
      const raw = JSON.parse(fs.readFileSync(this.configStorePath, 'utf-8'));
      return raw && typeof raw === 'object' ? raw : null;
    } catch {
      return null;
    }
  }

  /** 持久化飞书凭证到磁盘（跨 server 进程共享、重启不丢）。 */
  writePersistedConfig(config: FeishuConfig & { touched?: boolean }): void {
    try {
      fs.mkdirSync(path.dirname(this.configStorePath), { recursive: true });
      fs.writeFileSync(this.configStorePath, JSON.stringify(config), 'utf-8');
    } catch (e) {
      flog('写飞书凭证文件失败: ' + e);
    }
  }

  /**
   * 配置 / 重新配置飞书。
   * - enabled 开关随时更新（与凭证无关，关了则不推卡片但保留长连接）
   * - 凭证未变：不重建连接（绑定走磁盘共享文件，无需在此补）
   * - 凭证变化：停掉旧连接并以新凭证重建长连接
   * - 凭证为空：视为「关闭飞书」
   */
  async configure(config: FeishuConfig): Promise<void> {
    // 通知开关 / Get 表情回执开关 / 排队开关随时可改（与凭证无关），总是更新
    this.enabled = config.enabled !== false;
    this.ackReaction = config.ackReaction !== false;
    this.queueWhenBusy = config.queueWhenBusy !== false;

    const sameCred =
      this.config &&
      this.config.appId === config.appId &&
      this.config.appSecret === config.appSecret;

    // 凭证没变：仅开关变化，无需重建连接
    if (sameCred) return;

    // 凭证变化 → 重建
    await this.stop();

    if (!config.appId || !config.appSecret) {
      this.config = null;
      return;
    }

    this.config = config;

    if (!this.lark) {
      try {
        this.lark = await import('@larksuiteoapi/node-sdk');
      } catch (e) {
        flog('飞书 SDK 加载失败（请确认依赖已安装）: ' + e);
        this.config = null;
        return;
      }
    }

    const Lark = this.lark;
    try {
      this.client = new Lark.Client({ appId: config.appId, appSecret: config.appSecret });
      this.wsClient = new Lark.WSClient({
        appId: config.appId,
        appSecret: config.appSecret,
        loggerLevel: Lark.LoggerLevel.error,
      });

      const dispatcher = new Lark.EventDispatcher({}).register({
        'im.message.receive_v1': async (data: any) => {
          await this.handleInbound(data);
        },
      });

      this.wsClient.start({ eventDispatcher: dispatcher });
      this.connected = true;
      flog('飞书长连接已启动');
    } catch (e) {
      flog('飞书长连接启动失败: ' + e);
      this.connected = false;
    }
  }

  /** 单条 base64 图片体积上限：超过则改为落盘走文件通道，避免撑爆 MCP 消息 */
  private static readonly MAX_IMAGE_BASE64 = 8 * 1024 * 1024;
  /** inbound 临时文件保留时长：清理早于此的文件，防止磁盘堆积 */
  private static readonly INBOUND_TTL_MS = 24 * 60 * 60 * 1000;
  /**
   * 入站消息合并窗口：飞书会把「图片 + 文字」「多张图」拆成多条独立消息，
   * 若逐条结算会出现「第一条占用本轮反馈、其余丢失」+ 多次回执。
   * 这里在该窗口内按 chatId 把连续多条合并为一次反馈。
   */
  private static readonly INBOUND_MERGE_MS = 1200;
  /** 按 chatId 暂存待合并的入站消息 */
  private inboundBuffer = new Map<
    string,
    {
      parentId: string | null;
      lastMessageId: string;
      texts: string[];
      images: FeishuInboundImage[];
      files: string[];
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  /** 下载资源的临时落盘目录（系统临时区，跨进程一致） */
  private get inboundDir(): string {
    return path.join(os.tmpdir(), 'cursor-feedback-inbound');
  }

  /**
   * 处理用户发来的消息：支持 text / image / file / audio / media / post / sticker。
   * - 图片：小图转 base64 走视觉通道，大图落盘走文件通道
   * - 文件 / 音频 / 视频：下载落盘，回传绝对路径
   * - 富文本 post：拼接文字 + 下载内嵌图片
   * - 其他：降级为占位文字说明
   */
  private async handleInbound(data: any) {
    try {
      const msg = data?.message;
      if (!msg) return;

      const chatId: string = msg.chat_id || '';
      if (chatId) {
        // 任何来自用户的消息都把「推送目标」更新到磁盘（多进程共享、reload 不丢）
        this.setBoundChatId(chatId);
        this.onBindChange?.(chatId);
      }

      const messageId: string = msg.message_id || '';
      const msgType: string = msg.message_type || '';
      const parentId: string | null = msg.parent_id || null;

      let content: any = {};
      try {
        content = JSON.parse(msg.content || '{}');
      } catch {
        // 容错：content 非 JSON 时按空对象处理
      }

      let text = '';
      const images: FeishuInboundImage[] = [];
      const files: string[] = [];

      switch (msgType) {
        case 'text':
          text = (content.text || '').trim();
          break;
        case 'image': {
          const r = await this.ingestImage(messageId, content.image_key, images, files);
          if (!r.ok) text = `[图片接收失败：${r.reason || '未知原因'}]`;
          break;
        }
        case 'file':
        case 'audio':
        case 'media': {
          const fallbackName =
            msgType === 'audio' ? 'audio.opus' : msgType === 'media' ? 'video.mp4' : 'file.bin';
          const r = await this.ingestFile(
            messageId,
            content.file_key,
            content.file_name || fallbackName,
            files,
          );
          if (!r.ok) text = `[${msgType} 接收失败：${r.reason || '未知原因'}]`;
          break;
        }
        case 'post': {
          const r = await this.ingestPost(messageId, content);
          text = r.text;
          images.push(...r.images);
          break;
        }
        case 'sticker':
          text = '[表情]';
          break;
        default:
          text = `[暂不支持的消息类型: ${msgType || 'unknown'}]`;
      }

      this.bufferInbound(chatId, parentId, messageId, (text || '').trim(), images, files);
    } catch (e) {
      flog('处理飞书消息出错: ' + e);
    }
  }

  /**
   * 把单条消息并入合并缓冲：每来一条就重置定时器，静默 INBOUND_MERGE_MS 后
   * 将累积的文字 / 图片 / 文件合并为一次 onReply，根治飞书「图文拆条」导致的丢图与多回执。
   */
  private bufferInbound(
    chatId: string,
    parentId: string | null,
    messageId: string,
    text: string,
    images: FeishuInboundImage[],
    files: string[],
  ): void {
    const key = chatId || '_';
    const existing = this.inboundBuffer.get(key);
    if (existing) clearTimeout(existing.timer);
    const buf = existing || {
      parentId: null as string | null,
      lastMessageId: '',
      texts: [] as string[],
      images: [] as FeishuInboundImage[],
      files: [] as string[],
      timer: undefined as unknown as ReturnType<typeof setTimeout>,
    };
    if (!buf.parentId && parentId) buf.parentId = parentId;
    if (messageId) buf.lastMessageId = messageId;
    if (text) buf.texts.push(text);
    buf.images.push(...images);
    buf.files.push(...files);
    buf.timer = setTimeout(() => {
      this.inboundBuffer.delete(key);
      this.onReply?.({
        parentId: buf.parentId,
        text: buf.texts.join('\n').trim(),
        chatId,
        messageId: buf.lastMessageId,
        images: buf.images,
        files: buf.files,
      });
    }, FeishuBridge.INBOUND_MERGE_MS);
    this.inboundBuffer.set(key, buf);
  }

  /** 下载图片：小图走 base64(images)，大图落盘(files)。成功 ok=true，失败带 reason */
  private async ingestImage(
    messageId: string,
    imageKey: string | undefined,
    images: FeishuInboundImage[],
    files: string[],
  ): Promise<{ ok: boolean; reason?: string }> {
    const { buf, reason } = await this.fetchResource(messageId, imageKey, 'image');
    if (!buf) return { ok: false, reason };
    if (buf.length <= FeishuBridge.MAX_IMAGE_BASE64) {
      images.push({ name: `${imageKey}.jpg`, data: buf.toString('base64'), size: buf.length });
      return { ok: true };
    }
    const p = this.saveToTmp(buf, `${imageKey}.jpg`);
    if (p) {
      files.push(p);
      return { ok: true };
    }
    return { ok: false, reason: '图片落盘失败' };
  }

  /** 下载文件 / 音频 / 视频并落盘，回传绝对路径。成功 ok=true，失败带 reason */
  private async ingestFile(
    messageId: string,
    fileKey: string | undefined,
    name: string,
    files: string[],
  ): Promise<{ ok: boolean; reason?: string }> {
    const { buf, reason } = await this.fetchResource(messageId, fileKey, 'file');
    if (!buf) return { ok: false, reason };
    const p = this.saveToTmp(buf, name);
    if (p) {
      files.push(p);
      return { ok: true };
    }
    return { ok: false, reason: '文件落盘失败' };
  }

  /** 解析富文本 post：拼接文字 + 下载内嵌图片 */
  private async ingestPost(
    messageId: string,
    content: any,
  ): Promise<{ text: string; images: FeishuInboundImage[] }> {
    const images: FeishuInboundImage[] = [];
    const parts: string[] = [];
    if (content?.title) parts.push(String(content.title));
    const rows = Array.isArray(content?.content) ? content.content : [];
    for (const row of rows) {
      if (!Array.isArray(row)) continue;
      for (const el of row) {
        if (!el || typeof el !== 'object') continue;
        if (el.tag === 'text' && el.text) parts.push(String(el.text));
        else if (el.tag === 'a' && el.text) parts.push(`${el.text}(${el.href || ''})`);
        else if (el.tag === 'at') parts.push(`@${el.user_name || el.user_id || ''}`);
        else if (el.tag === 'img' && el.image_key) {
          const { buf, reason } = await this.fetchResource(messageId, el.image_key, 'image');
          if (buf && buf.length <= FeishuBridge.MAX_IMAGE_BASE64) {
            images.push({
              name: `${el.image_key}.jpg`,
              data: buf.toString('base64'),
              size: buf.length,
            });
          } else if (buf) {
            const p = this.saveToTmp(buf, `${el.image_key}.jpg`);
            if (p) parts.push(`[大图已存: ${path.basename(p)}]`);
          } else if (reason) {
            parts.push(`[图片接收失败：${reason}]`);
          }
        }
      }
    }
    return { text: parts.join(' ').trim(), images };
  }

  /**
   * 把飞书「获取消息资源」接口的错误码翻译成可读提示，直接回执给用户
   * （飞书里就能看到原因），不必翻 MCP 日志。码值含义见官方文档「获取消息中的资源文件」。
   */
  private static resourceErrorHint(
    code: number | undefined,
    status: number | undefined,
    msg: string | undefined,
  ): string {
    switch (code) {
      case 234009:
        return '飞书应用缺少读取消息资源的权限：请到开放平台「权限管理」开启 im:message（获取与发送单聊、群组消息）权限，重新发布版本后重试。';
      case 234004:
        return '机器人不在该消息所在的会话中（App not in chat）。';
      case 234003:
        return '资源与消息不匹配（File not in message）。';
      case 234037:
        return '资源超过 100MB 下载上限。';
      case 234001:
        return '请求参数有误（Invalid request param）。';
      default:
        return `飞书返回错误（code=${code ?? '?'} status=${status ?? '?'}${msg ? ' msg=' + msg : ''}）。`;
    }
  }

  /** 调用飞书「获取消息资源」接口；成功返回 { buf }，失败返回 { reason } */
  private async fetchResource(
    messageId: string,
    fileKey: string | undefined,
    type: 'image' | 'file',
  ): Promise<{ buf?: Buffer; reason?: string }> {
    if (!this.client) return { reason: '飞书未连接' };
    if (!messageId || !fileKey) return { reason: '缺少消息或资源标识' };
    try {
      const resp = await this.client.im.v1.messageResource.get({
        path: { message_id: messageId, file_key: fileKey },
        params: { type },
      });
      const stream = resp.getReadableStream();
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return { buf: Buffer.concat(chunks) };
    } catch (e: any) {
      // response 对象含 socket/agent 循环引用，不能整体 JSON.stringify，只摘关键字段
      const status = e?.response?.status ?? e?.status;
      const data = e?.response?.data;
      const code = data?.code ?? e?.code;
      const msg = data?.msg ?? e?.msg ?? e?.message;
      flog(`下载资源失败(${type}/${fileKey}): status=${status} code=${code} msg=${msg}`);
      return { reason: FeishuBridge.resourceErrorHint(code, status, msg) };
    }
  }

  /** 把二进制写入临时目录，返回绝对路径（失败返回 null）。顺手清理过期文件 */
  private saveToTmp(buf: Buffer, name: string): string | null {
    try {
      const dir = this.inboundDir;
      fs.mkdirSync(dir, { recursive: true });
      this.cleanupInbound(dir);
      const safe = (name || 'file').replace(/[^\w.\-]+/g, '_').slice(-80);
      const p = path.join(dir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safe}`);
      fs.writeFileSync(p, buf);
      return p;
    } catch (e) {
      flog('落盘失败: ' + e);
      return null;
    }
  }

  /** 清理 inbound 目录中早于 TTL 的文件，避免磁盘堆积 */
  private cleanupInbound(dir: string): void {
    try {
      const now = Date.now();
      for (const f of fs.readdirSync(dir)) {
        const fp = path.join(dir, f);
        try {
          if (now - fs.statSync(fp).mtimeMs > FeishuBridge.INBOUND_TTL_MS) fs.unlinkSync(fp);
        } catch {
          // 单个文件清理失败忽略
        }
      }
    } catch {
      // 目录不存在等忽略
    }
  }

  /**
   * 推送「反馈请求」交互卡片，返回卡片 message_id（失败返回 null）。
   */
  async sendFeedbackCard(
    requestId: string,
    summary: string,
    projectDir: string
  ): Promise<string | null> {
    if (!this.enabled) return null;
    const boundChatId = this.getBoundChatId();
    if (!this.client || !boundChatId) return null;
    try {
      const card = this.buildCard(summary, projectDir);
      const res = await this.client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: boundChatId,
          msg_type: 'interactive',
          content: JSON.stringify(card),
        },
      });
      const messageId: string | null = res?.data?.message_id || null;
      if (messageId) {
        // 卡片映射在请求结束后仍保留（用于「回复旧卡片 → 回执已结束」），用 FIFO 上界防止长期运行无限增长
        const MAX_CARDS = 200;
        while (this.cardToRequest.size >= MAX_CARDS) {
          const oldest = this.cardToRequest.keys().next().value;
          if (oldest === undefined) break;
          const oldReq = this.cardToRequest.get(oldest);
          this.cardToRequest.delete(oldest);
          if (oldReq !== undefined) {
            this.requestToCard.delete(oldReq);
            this.requestProjects.delete(oldReq);
          }
        }
        this.cardToRequest.set(messageId, requestId);
        this.requestToCard.set(requestId, messageId);
        this.requestProjects.set(requestId, projectDir);
        this.pendingSummaries.set(requestId, { summary, projectDir });
      }
      return messageId;
    } catch (e) {
      flog('飞书发送卡片失败: ' + e);
      return null;
    }
  }

  /** 用 parent_id 反查 requestId（命中返回 requestId，否则 null） */
  resolveParent(parentId: string | null): string | null {
    if (!parentId) return null;
    return this.cardToRequest.get(parentId) || null;
  }

  /** 查某 requestId 卡片的归属项目空间（请求结束后仍可查，用于忙时排队路由） */
  projectDirOf(requestId: string): string | null {
    return this.requestProjects.get(requestId) || null;
  }

  /** 本实例当前待回复的请求数（用于多窗口判断） */
  pendingCount(): number {
    return this.pendingSummaries.size;
  }

  /** 本实例当前待回复请求清单 */
  listPending(): Array<{ requestId: string; summary: string; projectDir: string }> {
    return Array.from(this.pendingSummaries.entries()).map(([requestId, v]) => ({
      requestId,
      summary: v.summary,
      projectDir: v.projectDir,
    }));
  }

  /** 本实例是否持有某 requestId 的卡片 */
  hasRequest(requestId: string): boolean {
    return this.requestToCard.has(requestId);
  }

  /** 取唯一待回复请求的 id（仅当恰好 1 个时有意义） */
  theOnlyPendingId(): string | null {
    if (this.pendingSummaries.size !== 1) return null;
    return this.pendingSummaries.keys().next().value || null;
  }

  /**
   * 请求结束（超时 / 插件已提交 / 飞书已回复）→ 仅清「待回复」计数，保留卡片 message_id 映射。
   * 保留映射让用户回复一张已结束的旧卡片时仍能被 resolveParent 命中、回执「已结束」，
   * 而不是因映射丢失被当成陌生卡片跨窗口广播、最终石沉大海。
   * 映射的无限增长由 sendFeedbackCard 的 FIFO 上界兜底。
   */
  clearPending(requestId: string) {
    this.pendingSummaries.delete(requestId);
  }

  /** 给某个会话回执一句话（纯文本） */
  async replyText(chatId: string, text: string): Promise<void> {
    if (!this.client || !chatId) return;
    try {
      await this.client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        },
      });
    } catch (e) {
      flog('飞书回执失败: ' + e);
    }
  }

  /**
   * 回复（引用）某条消息：用飞书 reply 接口让回执挂在原消息下，用户一眼看出是哪条。
   * messageId 缺失或调用失败时回退普通发送，保证提示一定送达。
   */
  async replyToMessage(
    messageId: string | undefined,
    chatId: string,
    text: string,
  ): Promise<void> {
    if (!this.client || !chatId) return;
    if (messageId) {
      try {
        await this.client.im.v1.message.reply({
          path: { message_id: messageId },
          data: { content: JSON.stringify({ text }), msg_type: 'text' },
        });
        return;
      } catch (e) {
        flog('飞书回复消息失败，回退普通发送: ' + e);
      }
    }
    await this.replyText(chatId, text);
  }

  /**
   * 给某条消息加 Get 表情作为「轻回执」：不产生新消息、不产生未读。
   * 失败（如该消息类型不支持表情）时回退文字回执，保证用户知道已收到。
   */
  async reactDone(messageId: string | undefined, chatIdForFallback?: string): Promise<void> {
    // Get 表情回执子开关关闭，或飞书通知主开关关闭 → 整个轻回执静默（不加表情、也不发文字兜底）
    if (!this.enabled || !this.ackReaction) return;
    if (!this.client || !messageId) {
      if (chatIdForFallback) {
        await this.replyText(chatIdForFallback, '✅ 已收到，已同步回 Cursor，等待AI回复中...');
      }
      return;
    }
    try {
      await this.client.im.v1.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: 'Get' } },
      });
    } catch (e) {
      flog('表情回应失败，回退文字: ' + e);
      if (chatIdForFallback) {
        await this.replyText(chatIdForFallback, '✅ 已收到，已同步回 Cursor，等待AI回复中...');
      }
    }
  }

  async stop(): Promise<void> {
    try {
      this.wsClient?.stop?.();
    } catch {
      // ignore
    }
    this.wsClient = null;
    this.client = null;
    this.connected = false;
  }

  /** 构建反馈请求卡片（JSON 2.0 卡片 + markdown 组件，纯展示 + 引导「回复」） */
  private buildCard(summary: string, projectDir: string) {
    const projectName =
      projectDir.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() || projectDir;

    // 飞书卡片有长度限制，过长摘要做截断（完整内容仍在 Cursor 面板）
    const MAX = 3000;
    let body = summary || '（无摘要）';
    if (body.length > MAX) {
      body = body.slice(0, MAX) + '\n\n…（内容过长已截断，完整内容见 Cursor 面板）';
    }

    // 飞书 JSON 2.0 卡片 + markdown 组件：相比 1.0 的 lark_md，额外支持标题(#)、
    // 引用(>)、表格、有序/无序列表、代码块等，让 AI 摘要在飞书里排版更完整。
    return {
      schema: '2.0',
      config: { wide_screen_mode: true },
      header: {
        template: 'carmine',
        title: { tag: 'plain_text', content: `Feedback 请求 · ${projectName}` },
      },
      body: {
        elements: [
          { tag: 'markdown', content: body },
          { tag: 'hr' },
          {
            tag: 'markdown',
            text_size: 'notation',
            content: '直接「回复」本条消息把反馈发回即可（多窗口时请回复对应卡片）',
          },
        ],
      },
    };
  }
}
