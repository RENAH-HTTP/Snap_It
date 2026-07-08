var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker/jam-worker.js
var jam_worker_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/jam") {
      const room = (url.searchParams.get("room") || "MAIN").toUpperCase();
      const id = env.JAM_ROOMS.idFromName(room);
      return env.JAM_ROOMS.get(id).fetch(request);
    }
    return env.ASSETS.fetch(request);
  }
};
var JamRoom = class {
  static {
    __name(this, "JamRoom");
  }
  constructor(state, env) {
    this.host = null;
    this.clients = /* @__PURE__ */ new Map();
    this.nextId = 1;
  }
  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const room = (new URL(request.url).searchParams.get("room") || "MAIN").toUpperCase();
    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    server.accept();
    this.wire(server, room);
    return new Response(null, { status: 101, webSocket: client });
  }
  wire(ws, room) {
    const data = { role: null, id: "c" + this.nextId++, name: "Player" };
    const send = /* @__PURE__ */ __name((obj) => {
      try {
        ws.send(JSON.stringify(obj));
      } catch (e) {
      }
    }, "send");
    ws.addEventListener("message", (ev) => {
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch (e) {
        return;
      }
      if (m.t === "join") {
        if (m.role === "host") {
          if (this.host && this.host !== ws) {
            send({ t: "denied", reason: "someone is already hosting room " + room });
            return;
          }
          this.host = ws;
          data.role = "host";
          send({ t: "role", role: "host", id: "host", room });
          for (const [id, c] of this.clients) send({ t: "peer-joined", id, name: c._name || "Player" });
        } else {
          data.role = "client";
          data.name = m.name || "Player";
          ws._name = data.name;
          ws._id = data.id;
          this.clients.set(data.id, ws);
          send({ t: "role", role: "client", id: data.id, room });
          if (this.host) this.host.send(JSON.stringify({ t: "peer-joined", id: data.id, name: data.name }));
          else send({ t: "status", text: "Waiting for a host to start room " + room + "\u2026" });
        }
        return;
      }
      if (m.t === "msg") {
        if (data.role === "host") {
          const wrapped = JSON.stringify({ t: "msg", from: "host", mtype: m.mtype, payload: m.payload });
          if (m.target) {
            const c = this.clients.get(m.target);
            if (c) c.send(wrapped);
          } else for (const c of this.clients.values()) c.send(wrapped);
        } else if (data.role === "client") {
          if (this.host) this.host.send(JSON.stringify({ t: "msg", from: data.id, mtype: m.mtype, payload: m.payload }));
        }
      }
    });
    const cleanup = /* @__PURE__ */ __name(() => {
      if (data.role === "host") {
        if (this.host === ws) this.host = null;
        for (const c of this.clients.values()) {
          try {
            c.send(JSON.stringify({ t: "host-gone" }));
          } catch (e) {
          }
        }
      } else if (data.role === "client") {
        this.clients.delete(data.id);
        if (this.host) {
          try {
            this.host.send(JSON.stringify({ t: "peer-left", id: data.id }));
          } catch (e) {
          }
        }
      }
    }, "cleanup");
    ws.addEventListener("close", cleanup);
    ws.addEventListener("error", cleanup);
  }
};

// ../../AppData/Local/npm-cache/_npx/32026684e21afda6/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// ../../AppData/Local/npm-cache/_npx/32026684e21afda6/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    return Response.json(error, {
      status: 500,
      headers: { "MF-Experimental-Error-Stack": "true" }
    });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-EiGpnp/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = jam_worker_default;

// ../../AppData/Local/npm-cache/_npx/32026684e21afda6/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-EiGpnp/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  scheduledTime;
  cron;
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  JamRoom,
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=jam-worker.js.map
