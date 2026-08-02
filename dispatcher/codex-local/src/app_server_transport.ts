import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { createInterface, type Interface } from "node:readline";

import { buildIsolationArgs, sanitizeCodexEnvironment } from "./config.js";
import { CodexDispatchError } from "./error.js";
import type { PreparedSetupComponent } from "./prepare.js";
import type { SessionIsolationOptions } from "./session_types.js";

interface JsonRecord {
  [key: string]: unknown;
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWithin(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

export function validateSessionIsolation(options: SessionIsolationOptions): {
  codexHome: string;
  cwd: string;
} {
  if (options.externalAuthentication !== "provisioned") {
    throw new CodexDispatchError(
      "persistent session authentication must be provisioned externally",
    );
  }
  if (!isAbsolute(options.codexHome) || !isAbsolute(options.cwd)) {
    throw new CodexDispatchError("session codexHome and cwd must be absolute");
  }
  if (!existsSync(options.codexHome)) {
    throw new CodexDispatchError("dedicated session codexHome must be provisioned before start");
  }
  if (existsSync(join(options.codexHome, "config.toml"))) {
    throw new CodexDispatchError("dedicated session codexHome must not contain config.toml");
  }
  const codexHome = realpathSync(options.codexHome);
  const cwd = realpathSync(options.cwd);
  const inheritedCodexHome =
    options.env === undefined ? process.env["CODEX_HOME"] : options.env["CODEX_HOME"];
  const defaultHome = resolve(inheritedCodexHome ?? join(homedir(), ".codex"));
  const comparableDefault = existsSync(defaultHome) ? realpathSync(defaultHome) : defaultHome;
  if (codexHome === comparableDefault) {
    throw new CodexDispatchError("persistent sessions require a dedicated non-default codexHome");
  }
  if (isWithin(cwd, codexHome) || isWithin(codexHome, cwd)) {
    throw new CodexDispatchError(
      "dedicated session codexHome and project cwd must not overlap",
    );
  }
  return { codexHome, cwd };
}

export function buildAppServerArgs(
  prepared: PreparedSetupComponent,
  options: SessionIsolationOptions,
): string[] {
  return [
    ...(options.codexArgsPrefix ?? []),
    "app-server",
    "--stdio",
    "--strict-config",
    ...buildIsolationArgs(prepared),
  ];
}

export class CodexAppServerTransport {
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly lines: Interface;
  private readonly child: ChildProcess;
  private closing = false;
  private closed = false;
  private killTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly closePromise: Promise<void>;

  private constructor(
    child: ChildProcess,
    private readonly timeoutMs: number,
    private readonly terminationGraceMs: number,
    private readonly onNotification: (method: string, params: unknown) => void,
    private readonly onDisconnect: (error?: CodexDispatchError) => void,
  ) {
    this.child = child;
    if (child.stdout === null || child.stdin === null || child.stderr === null) {
      throw new CodexDispatchError("app-server requires piped stdio");
    }
    child.stderr.resume();
    this.lines = createInterface({ input: child.stdout });
    this.lines.on("line", (line) => this.onLine(line));
    this.closePromise = new Promise((resolveClose) => {
      child.once("close", (code, signal) => {
        this.closed = true;
        this.lines.close();
        const detail = signal !== null ? `signal ${signal}` : `exit ${code ?? "unknown"}`;
        this.rejectPending(`app-server transport disconnected (${detail})`);
        if (!this.closing) this.onDisconnect();
        resolveClose();
      });
      child.once("error", () => {
        this.rejectPending("failed to start app-server");
      });
    });
  }

  static async start(
    prepared: PreparedSetupComponent,
    options: SessionIsolationOptions,
    onNotification: (method: string, params: unknown) => void,
    onDisconnect: (error?: CodexDispatchError) => void,
  ): Promise<CodexAppServerTransport> {
    return CodexAppServerTransport.startWithArgs(
      buildAppServerArgs(prepared, options),
      options,
      onNotification,
      onDisconnect,
    );
  }

  static async startWithArgs(
    args: string[],
    options: SessionIsolationOptions,
    onNotification: (method: string, params: unknown) => void,
    onDisconnect: (error?: CodexDispatchError) => void,
  ): Promise<CodexAppServerTransport> {
    const isolated = validateSessionIsolation(options);
    const child = spawn(options.codexBin ?? "codex", args, {
      cwd: isolated.cwd,
      env: {
        ...sanitizeCodexEnvironment(options.env),
        CODEX_HOME: isolated.codexHome,
      },
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const transport = new CodexAppServerTransport(
      child,
      options.timeoutMs ?? 10_000,
      options.terminationGraceMs ?? 1_000,
      onNotification,
      onDisconnect,
    );
    try {
      const initialized = await transport.request("initialize", {
        clientInfo: { name: "warble_codex_local", title: "Warble Codex Local", version: "0.1.0" },
        capabilities: { experimentalApi: true, requestAttestation: false },
      });
      if (!isRecord(initialized) || resolve(String(initialized["codexHome"] ?? "")) !== isolated.codexHome) {
        throw new CodexDispatchError("app-server initialize returned an unexpected codexHome");
      }
      transport.notify("initialized");
      return transport;
    } catch (error) {
      await transport.close();
      throw error;
    }
  }

  request(method: string, params: unknown = {}): Promise<unknown> {
    if (this.closed || this.closing || this.child.stdin === null) {
      return Promise.reject(new CodexDispatchError("app-server transport is not available"));
    }
    const id = this.nextId++;
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectRequest(new CodexDispatchError(`app-server request '${method}' timed out`));
        void this.close();
      }, this.timeoutMs);
      this.pending.set(id, { method, resolve: resolveRequest, reject: rejectRequest, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.write({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }

  async close(): Promise<void> {
    if (this.closing || this.closed) return this.closePromise;
    this.closing = true;
    this.signalTree("SIGTERM");
    this.killTimer = setTimeout(() => {
      if (!this.closed) this.signalTree("SIGKILL");
    }, this.terminationGraceMs);
    await this.closePromise;
    if (this.killTimer !== undefined) clearTimeout(this.killTimer);
  }

  private write(message: JsonRecord): void {
    if (this.child.stdin === null || this.child.stdin.destroyed) {
      throw new CodexDispatchError("app-server stdin is closed");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private onLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.protocolFailure("app-server emitted non-JSON output");
      return;
    }
    if (!isRecord(message)) {
      this.protocolFailure("app-server emitted a non-object message");
      return;
    }
    if (typeof message["id"] === "number" && ("result" in message || "error" in message)) {
      const pending = this.pending.get(message["id"]);
      if (!pending) {
        this.protocolFailure("app-server emitted a response for an unknown request");
        return;
      }
      this.pending.delete(message["id"]);
      clearTimeout(pending.timer);
      if (message["error"] !== undefined) {
        pending.reject(new CodexDispatchError(`app-server request '${pending.method}' failed`));
      } else {
        pending.resolve(message["result"]);
      }
      return;
    }
    if (typeof message["method"] === "string" && message["id"] === undefined) {
      try {
        this.onNotification(message["method"], message["params"]);
      } catch {
        this.protocolFailure("app-server notification violated the session contract");
      }
      return;
    }
    if (typeof message["method"] === "string" && message["id"] !== undefined) {
      this.write({
        jsonrpc: "2.0",
        id: message["id"],
        error: { code: -32601, message: "client request not supported" },
      });
      return;
    }
    this.protocolFailure("app-server emitted an invalid JSON-RPC message");
  }

  private protocolFailure(message: string): void {
    this.rejectPending(message);
    this.onDisconnect(new CodexDispatchError(message));
    void this.close();
  }

  private rejectPending(message: string): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new CodexDispatchError(message));
    }
    this.pending.clear();
  }

  private signalTree(signal: NodeJS.Signals): void {
    if (this.closed || this.child.pid === undefined) return;
    if (process.platform !== "win32") {
      try {
        process.kill(-this.child.pid, signal);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      }
    }
    this.child.kill(signal);
  }
}
