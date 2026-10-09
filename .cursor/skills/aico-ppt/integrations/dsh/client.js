window.__ModuleLoader__.load({
  id: "aico-ppt-skill",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const React = require("react");
    const h = React.createElement;
    const brand = globalThis.__AICO_PPT_BRAND__;
    let selectedAppUrl;
    const runtimeAppUrl = () => selectedAppUrl ?? brand?.appUrl;
    const optimisticSessionTitles = new Map();
    const sessionTitleWrites = new Map();

    const STYLE_ID = "aico-ppt-dsh-style";
    const STYLE = `
.hwd-workbench{position:relative;width:100%;height:100%;min-width:0;min-height:0;overflow:hidden;border-left:1px solid color-mix(in srgb,currentColor 12%,transparent);background:#eef0f3}
.hwd-workbench-frame{display:block;width:100%;height:100%;border:0;background:#eef0f3}
.hwd-workbench-error{position:absolute;inset:0;z-index:2;display:grid;place-items:center;padding:32px;background:#eef0f3;color:#5f6268;font:13px/1.7 "Noto Sans SC","Microsoft YaHei",sans-serif;text-align:center}
.hwd-workbench-toast{position:absolute;z-index:3;top:12px;left:50%;max-width:min(560px,calc(100% - 32px));padding:9px 12px;border:1px solid color-mix(in srgb,#c7000b 22%,transparent);border-radius:9px;background:color-mix(in srgb,#fff 94%,transparent);box-shadow:0 8px 28px rgba(20,22,28,.14);color:#8f0008;font:12px/1.5 "Noto Sans SC","Microsoft YaHei",sans-serif;transform:translateX(-50%);pointer-events:none}
.hwd-sidebar-action{display:flex;width:100%;height:36px;align-items:center;gap:10px;padding:0 10px;border:0;border-radius:8px;background:transparent;color:inherit;font:inherit;cursor:pointer;transition:background-color 150ms ease,color 150ms ease}
.hwd-sidebar-action:hover{background:color-mix(in srgb,currentColor 8%,transparent)}
.hwd-sidebar-action:focus-visible{outline:2px solid color-mix(in srgb,#c7000b 42%,transparent);outline-offset:1px}
.hwd-sidebar-action[data-wide=false]{width:36px;justify-content:center;padding:0}
.hwd-sidebar-icon{display:grid;width:18px;height:18px;flex:0 0 18px;place-items:center;color:#c7000b}
.hwd-sidebar-icon svg{display:block;width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
.hwd-sidebar-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
@media(prefers-reduced-motion:reduce){.hwd-sidebar-action{transition:none}}
`;

    function embeddedEditorUrl() {
      if (typeof runtimeAppUrl() !== "string") return null;
      try {
        const url = new URL(runtimeAppUrl());
        url.searchParams.set("embedded", "dsh");
        url.searchParams.set("parentOrigin", window.location.origin);
        return url.href;
      } catch (_error) {
        return null;
      }
    }

    function registeredLocalOrigin(value) {
      try {
        const url = new URL(value);
        if (url.protocol !== "http:"
          || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return null;
        return url.origin;
      } catch (_error) {
        return null;
      }
    }

    function appCommandUrl(pathname) {
      if (typeof runtimeAppUrl() !== "string") return null;
      try {
        const appUrl = new URL(runtimeAppUrl());
        const token = appUrl.searchParams.get("token");
        if (!token) return null;
        const endpoint = new URL(pathname, appUrl);
        endpoint.searchParams.set("token", token);
        return endpoint.href;
      } catch (_error) {
        return null;
      }
    }

    async function resolveDshSession(sessionId, includeRemoved = false) {
      const endpoint = appCommandUrl("/api/dsh-work-items/resolve-session");
      if (endpoint === null) return { status:"unlinked", workItem:null };
      const response = await fetch(endpoint, {
        method:"POST",
        // text/plain 保持简单跨源请求；App Server 只对带令牌的本地 DSH Origin
        // 开放这一条只读解析命令，不扩大其他写接口的 Origin 边界。
        headers:{ "content-type":"text/plain;charset=UTF-8" },
        body:JSON.stringify({ sessionId, includeRemoved }),
      });
      if (!response.ok) throw new Error(`工作项关联查询失败：HTTP ${response.status}`);
      return response.json();
    }

    function requireBridgeString(value, label) {
      if (typeof value !== "string" || value.length === 0 || value.length > 4096) {
        throw new Error(`${label} 无效`);
      }
      return value;
    }

    async function waitForWorkspaceReady(ctx) {
      const source = ctx.workspaces.list;
      if (source.getSnapshot()?.phase === "ready") return;
      await new Promise((resolve, reject) => {
        let unsubscribe = () => {};
        const timer = setTimeout(() => {
          unsubscribe();
          reject(Object.assign(new Error("工作区及归档状态仍在加载，请稍后重试"), { code:"WORKSPACE_NOT_READY" }));
        }, 30_000);
        const check = () => {
          if (source.getSnapshot()?.phase !== "ready") return;
          clearTimeout(timer);
          unsubscribe();
          resolve();
        };
        unsubscribe = source.subscribe(check);
        check();
      });
    }

    function archivedSessionIds(ctx) {
      const snapshot = ctx.workspaces?.list?.getSnapshot?.();
      if (snapshot?.phase !== "ready") throw Object.assign(new Error("工作区及归档状态尚未就绪"), { code:"WORKSPACE_NOT_READY" });
      return new Set(snapshot.archivedSessionIds);
    }

    function sessionSummary(ctx, sessionId) {
      if (ctx.workspaces.list.getSnapshot()?.phase !== "ready") return undefined;
      if (typeof sessionId !== "string") return null;
      const row = ctx.sessions.list.getSnapshot().byId?.[sessionId];
      const persistentTitle = typeof row?.title === "string"
        && row.title
        && row.title !== sessionId
        ? row.title
        : null;
      const displayTitle = typeof row?.displayTitle === "string"
        && row.displayTitle
        && row.displayTitle !== sessionId
        ? row.displayTitle
        : null;
      return {
        sessionId,
        title:persistentTitle
          || optimisticSessionTitles.get(sessionId)
          || displayTitle
          || sessionId,
        cwd:row?.cwd || null,
        running:Boolean(row?.running),
        archived:archivedSessionIds(ctx).has(sessionId),
      };
    }

    async function ensureSessionTitle(ctx, sessionId, title) {
      title = requireBridgeString(title, "title");
      const row = ctx.sessions.list.getSnapshot().byId?.[sessionId];
      if (typeof row?.title === "string" && row.title && row.title !== sessionId) return;
      const session = ctx.sessions.binding(sessionId)?.session;
      if (!session || typeof session.rename !== "function") {
        throw new Error(`DSH 会话不可命名：${sessionId}`);
      }
      const renamed = await session.rename(title);
      if (!renamed?.ok) {
        const code = renamed?.error?.code ? `${renamed.error.code}: ` : "";
        throw new Error(`DSH 会话命名失败：${code}${renamed?.error?.message || sessionId}`);
      }
    }

    function scheduleSessionTitle(ctx, sessionId, title) {
      title = requireBridgeString(title, "title");
      const row = ctx.sessions.list.getSnapshot().byId?.[sessionId];
      if (typeof row?.title === "string" && row.title && row.title !== sessionId) return;
      optimisticSessionTitles.set(sessionId, title);
      const current = sessionTitleWrites.get(sessionId);
      if (current?.title === title) return;
      const write = ensureSessionTitle(ctx, sessionId, title).catch(error => {
        if (optimisticSessionTitles.get(sessionId) === title) {
          optimisticSessionTitles.delete(sessionId);
        }
        console.warn(`DSH 会话中文标题补写失败：${sessionId}`, error);
      }).finally(() => {
        if (sessionTitleWrites.get(sessionId)?.write === write) {
          sessionTitleWrites.delete(sessionId);
        }
      });
      sessionTitleWrites.set(sessionId, { title, write });
    }

    function prepareSession(ctx, sessionId) {
      const session = ctx.sessions.binding(sessionId)?.session;
      if (!session || typeof session.open !== "function") {
        throw new Error(`DSH 会话不可打开：${sessionId}`);
      }
      // DSH 自己的 session follower 也以非阻塞方式启动 history window。
      // 打开中的流可能长期等待远端连接，不能让它阻塞 Session 选中和 Editor 导航。
      const opening = session.open();
      void Promise.resolve(opening).catch(error => {
        console.warn(`DSH 会话历史流打开失败：${sessionId}`, error);
      });
    }

    function sendToSession(ctx, sessionId, prompt) {
      requireBridgeString(sessionId, "sessionId");
      // 提示词含多个发行路径及页面规划，不适用标识符的 4096 字符限制。
      if (typeof prompt !== "string" || prompt.length > 256 * 1024 || !prompt.trim()) {
        throw new Error("prompt 无效");
      }
      const binding = ctx.sessions.binding(sessionId);
      const conversation = binding?.ctx.get("conversation");
      if (!conversation || typeof conversation.send !== "function") {
        throw new Error(`DSH 会话不可用：${sessionId}`);
      }
      return conversation.send(prompt);
    }

    async function restoreLinkedSession(ctx, sessionId) {
      await waitForWorkspaceReady(ctx);
      const linked = await resolveDshSession(sessionId, true);
      const work = linked?.workItem;
      if (!work) return false;
      if (ctx.workspaces.projectSessionCapabilities?.restore === false) {
        throw Object.assign(new Error("当前原装宿主不支持恢复原会话；请恢复项目后新建会话"), { code:"PROJECT_RESTORE_UNSUPPORTED" });
      }
      if (work.lifecycle === "removing") throw new Error("项目正在移除，请先完成移除后恢复会话");
      const workspace = await ctx.workspaces.create({ path:work.projectRoot });
      const response = await fetch(appCommandUrl("/api/dsh-work-items/restore-session"), {
        method:"POST", headers:{ "content-type":"text/plain;charset=UTF-8" },
        body:JSON.stringify({ workId:work.workId, sessionId, workspaceId:workspace.workspaceId, expectedRevision:work.revision }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || "项目会话恢复尚未完成，请重试");
      await ctx.workspaces.projectSessions({
        operationId:result.workItem.restoreOperation.operationId,
        action:"restore", sessionIds:[sessionId], workspaceId:workspace.workspaceId,
      });
      const completed = await fetch(appCommandUrl("/api/dsh-work-items/complete-restore"), {
        method:"POST", headers:{ "content-type":"text/plain;charset=UTF-8" },
        body:JSON.stringify({ workId:work.workId, operationId:result.workItem.restoreOperation.operationId }),
      });
      if (!completed.ok) throw new Error("会话恢复收据尚未保存，请在项目首页重试恢复");
      return true;
    }

    function createDshWorkBridge(ctx) {
      return async (command, payload = {}) => {
        await waitForWorkspaceReady(ctx);
        switch (command) {
          case "current-session": {
            return sessionSummary(ctx, ctx.sessions.list.getSnapshot().current);
          }
          case "describe-sessions": {
            if (!Array.isArray(payload.sessionIds)) throw new Error("sessionIds 无效");
            const snapshot = ctx.sessions.list.getSnapshot();
            const archived = archivedSessionIds(ctx);
            return payload.sessionIds.map(sessionId => {
              sessionId = requireBridgeString(sessionId, "sessionId");
              return snapshot.byId?.[sessionId] || archived.has(sessionId)
                ? sessionSummary(ctx, sessionId) : null;
            });
          }
          case "restore-linked-session": {
            return restoreLinkedSession(ctx, requireBridgeString(payload.sessionId, "sessionId"));
          }
          case "project-sessions": {
            if (typeof ctx.workspaces.projectSessions !== "function") throw Object.assign(new Error("当前宿主尚不支持项目关联会话的批量归档与恢复；项目移除未完成，内容文件保留"), { code:"HOST_LIFECYCLE_UNAVAILABLE" });
            return ctx.workspaces.projectSessions(payload);
          }
          case "ensure-workspace": {
            const workspace = await ctx.workspaces.create({
              path:requireBridgeString(payload.path, "path"),
            });
            return {
              workspaceId:workspace.workspaceId,
              path:workspace.path,
              title:workspace.title,
            };
          }
          case "create-session": {
            const workspaceId = requireBridgeString(payload.workspaceId, "workspaceId");
            const sessionId = requireBridgeString(payload.sessionId, "sessionId");
            const createdId = await ctx.sessions.create({ workspaceId, sessionId });
            if (payload.title !== undefined) {
              scheduleSessionTitle(ctx, createdId, payload.title);
            }
            return sessionSummary(ctx, createdId) || { sessionId:createdId };
          }
          case "fork-session": {
            const sourceSessionId = requireBridgeString(payload.sourceSessionId, "sourceSessionId");
            const childId = await ctx.sessions.fork({
              sessionId:sourceSessionId,
              increaseTitle:true,
            });
            return sessionSummary(ctx, childId) || { sessionId:childId };
          }
          case "open-session": {
            const sessionId = requireBridgeString(payload.sessionId, "sessionId");
            if (archivedSessionIds(ctx).has(sessionId)) throw new Error("会话已归档，请从历史记录明确恢复");
            if (payload.title !== undefined) {
              scheduleSessionTitle(ctx, sessionId, payload.title);
            }
            if (payload.workspaceId) await ctx.sessions.create({ sessionId, workspaceId:payload.workspaceId });
            prepareSession(ctx, sessionId);
            ctx.sessions.open(sessionId);
            return sessionSummary(ctx, sessionId) || { sessionId };
          }
          case "send-to-session": {
            const sessionId = requireBridgeString(payload.sessionId, "sessionId");
            await sendToSession(ctx, sessionId, payload.prompt);
            return { accepted:true, sessionId };
          }
          default:
            throw new Error(`不支持的 DSH Bridge 命令：${String(command)}`);
        }
      };
    }

    function projectName(projectRoot) {
      if (typeof projectRoot !== "string") return "未命名项目";
      const parts = projectRoot.split(/[\\/]+/).filter(Boolean);
      return parts.at(-1) || projectRoot;
    }

    function describeSessionStartTarget(workItem) {
      if (!workItem || typeof workItem !== "object"
        || typeof workItem.workId !== "string"
        || typeof workItem.projectRoot !== "string"
        || !["creation", "editing"].includes(workItem.kind)) return null;
      const revision = workItem.dshBinding?.revision ?? workItem.revision;
      if (!Number.isInteger(revision) || revision < 0) return null;
      const displayName = workItem.kind === "editing"
        ? (workItem.deckName || projectName(workItem.deckPath) || workItem.displayName || "未命名 Deck")
        : (workItem.displayName || workItem.title || "未命名 Deck");
      return {
        workId:workItem.workId,
        contextKey:`${workItem.workId}:${revision}`,
        kind:workItem.kind,
        displayName,
        projectRoot:workItem.projectRoot,
        projectName:workItem.projectName || projectName(workItem.projectRoot),
      };
    }

    function sessionStartTargetsFromHistory(history) {
      const seen = new Set();
      const targets = [];
      for (const workItem of [
        ...(Array.isArray(history?.creation) ? history.creation : []),
        ...(Array.isArray(history?.editing) ? history.editing : []),
      ]) {
        const target = describeSessionStartTarget(workItem);
        if (target === null || seen.has(target.workId)) continue;
        seen.add(target.workId);
        targets.push(target);
      }
      return targets;
    }

    let catalogFetchSequence = 0;
    async function fetchSessionStartTargets() {
      const fetchSequence = ++catalogFetchSequence;
      const endpoint = appCommandUrl("/api/work-history");
      if (endpoint === null) return [];
      const metadataEndpoint = new URL(endpoint);
      metadataEndpoint.searchParams.set("bindings", "metadata");
      const response = await fetch(metadataEndpoint.href, { headers:{ accept:"application/json" } });
      if (!response.ok) throw new Error(`AICO-PPT 项目列表读取失败：HTTP ${response.status}`);
      const targets = sessionStartTargetsFromHistory(await response.json());
      targets.fetchSequence = fetchSequence;
      return targets;
    }

    function createContextualSessionStart(openWorkbench) {
      let active = null;
      let snapshot = [];
      let targetByKey = new Map();
      let preferredWorkId = null;
      let currentWorkId = null;
      let sequence = 0;
      let appliedCatalogSequence = 0;
      const listeners = new Set();
      const pending = new Map();
      const source = {
        getSnapshot:() => snapshot,
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
      const publish = () => {
        for (const listener of listeners) listener();
      };
      const clear = (target) => {
        if (target && active?.target !== target) return;
        active = null;
      };
      const validContext = context => Boolean(context && typeof context === "object"
        && typeof context.workId === "string"
        && typeof context.contextKey === "string"
        && ["creation", "editing"].includes(context.kind));
      const replaceTargets = (targets) => {
        if (targets?.fetchSequence < appliedCatalogSequence) return;
        if (targets?.fetchSequence) appliedCatalogSequence = targets.fetchSequence;
        const ordered = [];
        const seen = new Set();
        for (const candidate of Array.isArray(targets) ? targets : []) {
          if (!validContext(candidate) || seen.has(candidate.workId)) continue;
          seen.add(candidate.workId);
          ordered.push(candidate);
        }
        const preferredIndex = ordered.findIndex(row => row.workId === preferredWorkId);
        if (preferredIndex > 0) ordered.unshift(ordered.splice(preferredIndex, 1)[0]);
        const next = ordered.map(row => ({
          key:row.contextKey,
          label:row.displayName || "未命名 Deck",
          description:row.projectName || projectName(row.projectRoot),
          current:row.workId === currentWorkId,
        }));
        targetByKey = new Map(ordered.map(row => [row.contextKey, row]));
        const unchanged = snapshot.length === next.length && snapshot.every((row, index) => (
          row.key === next[index]?.key
          && row.label === next[index]?.label
          && row.description === next[index]?.description
          && row.current === next[index]?.current
        ));
        if (unchanged) return;
        snapshot = next;
        publish();
      };
      const prefer = (workId) => {
        currentWorkId = typeof workId === "string" ? workId : null;
        preferredWorkId = currentWorkId;
        replaceTargets([...targetByKey.values()]);
      };
      const sendCreateRequest = (request, target, origin) => {
        if (request.createSent) return;
        request.createSent = true;
        target.postMessage({
          type:"aico-ppt:create-work-session-request",
          requestId:request.requestId,
          workId:request.context.workId,
          contextKey:request.context.contextKey,
        }, origin);
      };
      const route = (request) => {
        if (active === null) {
          openWorkbench();
          return;
        }
        if (validContext(active.context)
          && request.context.contextKey === active.context.contextKey
          && request.context.workId === active.context.workId) {
          sendCreateRequest(request, active.target, active.origin);
          return;
        }
        if (request.navigateSent) return;
        request.navigateSent = true;
        active.target.postMessage({
          type:"aico-ppt:navigate-work-session-target-request",
          requestId:request.requestId,
          workId:request.context.workId,
          contextKey:request.context.contextKey,
        }, active.origin);
      };
      const adopt = (context, target, origin, targets) => {
        if (targets?.fetchSequence < appliedCatalogSequence) return;
        if (context !== null && !validContext(context)) return;
        const ordered = [];
        const seen = new Set();
        for (const candidate of [
          ...(validContext(context) ? [context] : []),
          ...(Array.isArray(targets) ? targets : []),
        ]) {
          if (!validContext(candidate) || seen.has(candidate.workId)) continue;
          seen.add(candidate.workId);
          ordered.push(candidate);
        }
        active = { context, target, origin };
        if (validContext(context) && currentWorkId === null) preferredWorkId = context.workId;
        ordered.fetchSequence = targets?.fetchSequence;
        if (Array.isArray(targets) || ordered.length > 0) replaceTargets(ordered);
        for (const request of pending.values()) route(request);
      };
      const receive = (message) => {
        const request = pending.get(message.requestId);
        if (!request) return;
        pending.delete(message.requestId);
        clearTimeout(request.timer);
        if (message.ok === true) request.resolve(message.result);
        else request.reject(new Error(message.error?.message || "无法创建任务会话"));
      };
      const start = (option) => {
        const context = targetByKey.get(option.key);
        if (context === undefined || !snapshot.some(candidate => candidate.key === option.key)) {
          return Promise.reject(new Error("当前 Deck 已切换，请重新选择任务会话"));
        }
        const requestId = `aico-ppt-session-${Date.now()}-${++sequence}`;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            pending.delete(requestId);
            reject(new Error("等待 AICO-PPT 创建任务会话超时"));
          }, 120000);
          const request = {
            requestId, context, resolve, reject, timer,
            createSent:false, navigateSent:false,
          };
          pending.set(requestId, request);
          route(request);
        });
      };
      const dispose = () => {
        clear();
        for (const request of pending.values()) {
          clearTimeout(request.timer);
          request.reject(new Error("AICO-PPT 工作台已关闭"));
        }
        pending.clear();
        targetByKey.clear();
        snapshot = [];
        listeners.clear();
      };
      return { source, adopt, clear, receive, refresh:replaceTargets, prefer, start, dispose };
    }

    function AicoPptWorkbench(props) {
      const frame = React.useRef(null);
      const lastPublishedSession = React.useRef(null);
      const allowedFrameOrigins = React.useRef(null);
      const activeFrameOrigin = React.useRef(null);
      const [error, setError] = React.useState("");
      const editorUrl = embeddedEditorUrl();
      const appOrigin = editorUrl === null ? null : new URL(editorUrl).origin;
      if (allowedFrameOrigins.current === null) {
        allowedFrameOrigins.current = new Set(appOrigin === null ? [] : [appOrigin]);
      }
      if (activeFrameOrigin.current === null) activeFrameOrigin.current = appOrigin;

      const publishCurrentSession = (force = false) => {
        const target = frame.current?.contentWindow;
        const targetOrigin = activeFrameOrigin.current;
        if (targetOrigin === null || !target) return;
        const session = props.currentSession();
        if (session === undefined) return;
        const signature = JSON.stringify(session);
        if (!force && signature === lastPublishedSession.current) return;
        target.postMessage({
          type:"aico-ppt:dsh-session-changed",
          session,
        }, targetOrigin);
        lastPublishedSession.current = signature;
      };

      React.useEffect(() => {
        if (appOrigin === null) return () => {};
        const publish = () => publishCurrentSession(false);
        const unsubscribers = [];
        if (props.sessionSource?.subscribe) {
          unsubscribers.push(props.sessionSource.subscribe(publish));
        }
        if (props.workspaceSource?.subscribe) {
          // 归档非当前会话时，current 摘要不会变化，但 Editor 仍需立刻刷新选择器。
          unsubscribers.push(props.workspaceSource.subscribe(() => publishCurrentSession(true)));
        }
        // 某些 DSH 页面布局切换时，current 已更新但 list 的订阅通知可能晚到或漏发。
        // 轮询只读取本地 snapshot，且仅在摘要变化时发一条消息，作为低成本可靠性兜底。
        const poll = setInterval(publish, 250);
        publishCurrentSession(true);
        return () => {
          clearInterval(poll);
          for (const unsubscribe of unsubscribers) unsubscribe();
          props.sessionStarter.clear(frame.current?.contentWindow);
        };
      }, [appOrigin, props.currentSession, props.sessionSource, props.sessionStarter, props.workspaceSource]);

      React.useEffect(() => {
        const onMessage = async (event) => {
          if (event.source !== frame.current?.contentWindow
            || !event.data || typeof event.data !== "object") return;
          if (event.data.type === "aico-ppt:dsh-frame-origin") {
            if (event.origin !== appOrigin) return;
            const origin = registeredLocalOrigin(event.data.origin);
            if (origin === null) return;
            allowedFrameOrigins.current.add(origin);
            activeFrameOrigin.current = origin;
            return;
          }
          if (!allowedFrameOrigins.current.has(event.origin)) return;
          activeFrameOrigin.current = event.origin;
          if (event.data.type === "aico-ppt:dsh-ready") {
            // iframe 可能晚于 workbench effect 安装消息监听器；ready 后强制重放当前会话。
            publishCurrentSession(true);
            return;
          }
          if (event.data.type === "aico-ppt:dsh-work-context") {
            await waitForWorkspaceReady({ workspaces:{ list:props.workspaceSource } });
            // iframe 的迟到上下文不是项目存在性的证据；以服务端目录为准。
            const targets = await fetchSessionStartTargets();
            const context = targets.find(target => target.workId === event.data.context?.workId) ?? null;
            props.sessionStarter.adopt(context, event.source, event.origin, targets);
            return;
          }
          if (event.data.type === "aico-ppt:create-work-session-result"
            && typeof event.data.requestId === "string") {
            props.sessionStarter.receive(event.data);
            return;
          }
          if (event.data.type === "aico-ppt:close-workbench") {
            props.closeWorkbench();
            return;
          }
          if (event.data.type === "aico-ppt:dsh-request"
            && typeof event.data.requestId === "string"
            && typeof event.data.command === "string") {
            try {
              const result = await props.executeDshCommand(event.data.command, event.data.payload);
              event.source.postMessage({
                type:"aico-ppt:dsh-result",
                requestId:event.data.requestId,
                ok:true,
                result,
              }, event.origin);
              setError("");
            } catch (cause) {
              const message = cause instanceof Error ? cause.message : String(cause);
              event.source.postMessage({
                type:"aico-ppt:dsh-result",
                requestId:event.data.requestId,
                ok:false,
                error:{ message, code:cause?.code || cause?.rpcError?.code },
              }, event.origin);
              setError(`DSH 操作失败：${message}`);
            }
            return;
          }
          if (event.data.type !== "aico-ppt:agent-request"
            || typeof event.data.requestId !== "string"
            || typeof event.data.prompt !== "string") return;
          let accepted = false;
          let message = "";
          try {
            if (typeof props.sendTask !== "function") throw new Error("当前没有可用的 DSH 会话");
            await props.sendTask(event.data.prompt, event.data.sessionId);
            accepted = true;
            setError("");
          } catch (cause) {
            message = cause instanceof Error ? cause.message : String(cause);
            setError(`任务提交失败：${message}`);
          }
          event.source.postMessage({
            type:"aico-ppt:agent-result",
            requestId:event.data.requestId,
            accepted,
            message,
          }, event.origin);
        };
        window.addEventListener("message", onMessage);
        return () => window.removeEventListener("message", onMessage);
      }, [appOrigin, props.closeWorkbench, props.executeDshCommand, props.sendTask, props.sessionStarter]);

      if (editorUrl === null) {
        return h("section", { className:"hwd-workbench" },
          h("div", { className:"hwd-workbench-error", role:"alert" }, brand?.error || "AICO-PPT Editor 运行时没有启动。请重启 DSH Desktop。"));
      }
      return h("section", { className:"hwd-workbench", "aria-label":"AICO-PPT Editor" },
        h("iframe", {
          ref:frame,
          className:"hwd-workbench-frame",
          src:editorUrl,
          title:"AICO-PPT Editor",
          onLoad:() => {
            props.sessionStarter.clear(frame.current?.contentWindow);
            publishCurrentSession(true);
          },
          allow:"clipboard-read *; clipboard-write *; fullscreen *",
          sandbox:"allow-scripts allow-same-origin allow-forms allow-modals allow-downloads allow-popups",
        }),
        error ? h("div", { className:"hwd-workbench-toast", role:"alert" }, error) : null);
    }

    function AicoPptLauncher(props) {
      return h("button", {
        type:"button",
        className:"hwd-sidebar-action",
        "data-wide":String(props.wide),
        "aria-label":"AICO-PPT",
        title:"AICO-PPT",
        onClick:props.toggleWorkbench,
      },
      h("span", { className:"hwd-sidebar-icon", "aria-hidden":"true" },
        h("svg", { viewBox:"0 0 24 24" },
          h("rect", { x:"3.5", y:"4.5", width:"17", height:"15", rx:"2.5" }),
          h("path", { d:"M7 15l3.2-3.2 2.4 2.4 2.4-2.4 2 2" }),
          h("path", { d:"M8 8.5h8" }))),
      props.wide ? h("span", { className:"hwd-sidebar-label" }, "AICO-PPT") : null);
    }

    const inject = ["slots", "sessions", "workspaces", "conversation", "workbench", "sessionStarts"];

    function apply(ctx) {
      if (globalThis.__AICO_PPT_PREPARE__) {
        const controller = new AbortController();
        ctx.effect(() => () => controller.abort(new Error("AICO-PPT Client 已卸载")));
        return globalThis.__AICO_PPT_PREPARE__({ signal:controller.signal }).then(value => {
          controller.signal.throwIfAborted();
          selectedAppUrl = value.appUrl;
          if (typeof selectedAppUrl !== "string") throw new Error("所选后端未提供 AICO-PPT 工作台地址");
          return mount(ctx);
        });
      }
      return mount(ctx);
    }

    function mount(ctx) {
      ctx = ctx.get?.('aicoHarnessClient')?.bind(ctx) ?? ctx;
      const sessionStarter = createContextualSessionStart(() => {
        if (ctx.workbench.active?.() !== "aico-ppt") ctx.workbench.open("aico-ppt", 1100);
      });
      ctx.effect(() => {
        const unregister = ctx.sessionStarts.register({
          id:"aico-ppt",
          label:"AICO-PPT",
          order:20,
          source:sessionStarter.source,
          start:option => sessionStarter.start(option),
        });
        return () => {
          unregister();
          sessionStarter.dispose();
        };
      }, "aico-ppt: 统一新会话入口");

      ctx.effect(() => {
        let disposed = false;
        const refresh = () => {
          void waitForWorkspaceReady(ctx).then(() => fetchSessionStartTargets()).then(targets => {
            if (!disposed) sessionStarter.refresh(targets);
          }).catch(error => {
            if (!disposed) console.warn("AICO-PPT 项目列表刷新失败", error);
          });
        };
        refresh();
        window.addEventListener("focus", refresh);
        return () => {
          disposed = true;
          window.removeEventListener("focus", refresh);
        };
      }, "aico-ppt: 常驻项目会话目标");

      ctx.effect(() => {
        const navigation = ctx.get?.('aicoSessionNavigation');
        if (navigation) return navigation.register({
          id:'aico-ppt', width:1100, closeOnUnlinked:true,
          async resolve(sessionId, signal) {
            await waitForWorkspaceReady(ctx);
            signal.throwIfAborted();
            if (archivedSessionIds(ctx).has(sessionId)) return null;
            if (appCommandUrl('/api/dsh-work-items/resolve-session') === null) throw new Error('PPT 关联查询尚未就绪');
            const result = await resolveDshSession(sessionId);
            signal.throwIfAborted();
            if (!['linked', 'unlinked'].includes(result?.status)) throw new Error('PPT 关联查询状态无效');
            if (result.status === 'linked' && !result.workItem?.workId) throw new Error('PPT 关联项目无效');
            return result.status === 'linked' ? result.workItem : null;
          },
          selected:work => sessionStarter.prefer(work?.workId ?? null),
        });
        let selectionRevision = 0;
        let disposed = false;
        const inspectSelection = (sessionId) => {
          const revision = ++selectionRevision;
          if (typeof sessionId !== "string") return;
          void waitForWorkspaceReady(ctx).then(() => archivedSessionIds(ctx).has(sessionId)
            ? { status:"unlinked" } : resolveDshSession(sessionId)).then(result => {
            if (disposed || revision !== selectionRevision
              || ctx.sessions.list.getSnapshot().current !== sessionId) return;
            const linked = result?.status === "linked";
            sessionStarter.prefer(linked ? result.workItem?.workId : null);
            const activeWorkbench = ctx.workbench.active?.() ?? null;
            if (linked) {
              if (activeWorkbench !== "aico-ppt") ctx.workbench.open("aico-ppt", 1100);
              return;
            }
            if (activeWorkbench === "aico-ppt") ctx.workbench.close();
          }).catch(error => {
            console.warn(`DSH 会话的 Deck 关联查询失败：${sessionId}`, error);
          });
        };
        const unsubscribe = ctx.on("session/open-requested", inspectSelection);
        inspectSelection(ctx.sessions.list.getSnapshot().current);
        return () => {
          disposed = true;
          selectionRevision += 1;
          unsubscribe?.();
        };
      }, "aico-ppt: 已关联会话自动打开 Editor");

      ctx.effect(() => ctx.on("session/restore-requested", async ({ sessionId }, next) => {
        if (!await restoreLinkedSession(ctx, sessionId)) return next();
        sessionStarter.refresh(await fetchSessionStartTargets());
      }), "aico-ppt: 明确恢复历史会话");

      ctx.effect(() => {
        if (document.getElementById(STYLE_ID) !== null) return () => {};
        const style = document.createElement("style");
        style.id = STYLE_ID;
        style.textContent = STYLE;
        document.head.appendChild(style);
        return () => style.remove();
      }, "aico-ppt: Editor 嵌入样式");

      ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
        name:"sidebar.footer.action",
        id:"aico-ppt",
        order:10,
        inject:() => ({ toggleWorkbench:() => ctx.workbench.toggle("aico-ppt", 1100) }),
      }, AicoPptLauncher));

      ctx.slots.inject("workbench.persistent-view", () => ctx.slots.register({
        name:"workbench.persistent-view",
        id:"aico-ppt",
        order:20,
        inject:() => {
          const executeDshCommand = createDshWorkBridge(ctx);
          const currentSession = () => sessionSummary(ctx, ctx.sessions.list.getSnapshot().current);
          const sendTask = async (prompt, requestedSessionId) => {
            const sessionId = requireBridgeString(requestedSessionId, "sessionId");
            await sendToSession(ctx, sessionId, prompt);
          };
          return {
            currentSession,
            executeDshCommand,
            sendTask,
            sessionStarter,
            sessionSource:ctx.sessions.list,
            workspaceSource:ctx.workspaces.list,
          };
        },
      }, AicoPptWorkbench));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
