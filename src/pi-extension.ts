// reason network for pi: written by `reason network setup`, removed by `reason uninstall`.
// Gives each session reason network's tools (deferred: kept out of the model's context until it looks for them), tells
// reason network whether the session is busy and what it is called, and delivers teammates' messages into it.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { execFile } from "node:child_process"
import { appendFileSync, readFileSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join, resolve } from "node:path"

const ENGINE = "__ENGINE_EXE__"

// ---- holding a fixed session name ----
// A session that never asks for a name keeps the daemon's automatic one, which changes on every /new and /handoff: mail
// sent to the old name then waits forever. So ask for a name from the session's own folder, and ignore a refusal that
// says the name is somebody else's.
const CLAIM_LOG = join(homedir(), ".pi", "agent", "rn-claim.log")
const NAME_POLICY = join(homedir(), ".pi", "agent", "rn-names.json")
// Scratch folders get no fixed name: an experiment should not leave a name behind in the directory.
const NO_NAME_DIRS = ["/tmp", "/var/tmp", "/run"]

function claimLog(line: string): void {
  try {
    appendFileSync(CLAIM_LOG, `${new Date().toISOString()} ${line}\n`)
  } catch {
    /* a log we cannot write must not break the session */
  }
}

/// The name this folder asks for, or null to keep the daemon's automatic name. RN_FIXED_NAME wins (so a test can aim a
/// throwaway session at a name), then a per-folder override in rn-names.json, then the folders that have always held a
/// fixed name, then `<folder>-pi`.
function wantedName(cwd: string): string | null {
  const fromEnv = process.env.RN_FIXED_NAME?.trim()
  if (fromEnv) return fromEnv
  let real = resolve(cwd)
  try {
    real = realpathSync(cwd)
  } catch {
    /* a folder we cannot resolve is matched as given */
  }
  try {
    const map = JSON.parse(readFileSync(NAME_POLICY, "utf8")) as Record<string, unknown>
    const chosen = [real, cwd, resolve(cwd)].map((key) => map[key]).find((v) => typeof v === "string" && v.trim())
    if (typeof chosen === "string") return chosen.trim()
  } catch {
    /* no override file, or one we cannot read: the defaults below still apply */
  }
  if (NO_NAME_DIRS.some((dir) => real === dir || real.startsWith(`${dir}/`))) return null
  const home = homedir()
  if (real === join(home, "jingguan")) return "jingguan-pi"
  // A firstmate home and a treehouse secondmate must not share a name: whichever starts first would take it, and the
  // other's mail would land in the wrong session.
  if (/\/ghq\/github\.com\/[^/]+\/firstmate$/.test(real)) return "firstmate-pi"
  if (/\/\.treehouse\/[^/]+\/[^/]+\/firstmate$/.test(real)) return "firstmate-ops"
  const leaf = basename(real)
  return leaf && leaf !== "/" ? `${leaf}-pi` : null
}

type Claim = {
  name: string
  cwd: string
  id: string
  /** No further attempts: claimed, gave up, or a refusal that trying again cannot fix. */
  done: boolean
  /** The name is a live session's; ask again at each turn's end until it frees up. */
  refusedLive: boolean
  /** The live refusal is logged once, not at every turn's end. */
  skipLogged: boolean
  /** Nothing is attempted before this instant (0: no wait known). */
  graceUntil: number
  /** The one attempt at the instant above has been spent. */
  graceTried: boolean
}

let claim: Claim | null = null

/// `status --name` takes the session from the environment, as it would in the session's own shell; the daemon answers on
/// stdout when it accepts and on stderr when it refuses, so both are read.
function setStatusName(c: Claim): Promise<string> {
  return new Promise((done) =>
    execFile(
      ENGINE,
      ["status", "--name", c.name],
      {
        cwd: c.cwd,
        timeout: 15_000,
        windowsHide: true,
        env: { ...process.env, REASON_NETWORK_AGENT: "pi", REASON_NETWORK_SESSION: c.id },
      },
      (err, out, errOut) =>
        done(`${out ?? ""}${errOut ?? ""}`.trim() || (err ? String(err.message ?? "error") : "")),
    ),
  )
}

/// One claim attempt; `final` is the one attempt after a grace, which is not allowed to buy another wait. A refusal is
/// classified by the daemon's own sentence, which is formatted at src/daemon/sessions.rs:377-384 of upstream v0.12.17
/// (the spacing, the singular/plural unit and the trailing period were read there on 2026-11-22): a wording change
/// upstream invalidates the parse, so an unrecognised refusal falls back to "give up", never to "retry forever".
async function attempt(c: Claim, via: string, final = false): Promise<void> {
  if (c.done) return
  const out = await setStatusName(c)
  const first = (out.split("\n")[0] ?? "").trim()
  if (/You are \S+/.test(out)) {
    c.done = true
    c.refusedLive = false
    claimLog(`claim ok name=${c.name} via=${via} out=${first}`)
    return
  }
  if (/taken by a live session/i.test(out)) {
    if (!c.skipLogged) claimLog(`claim skipped name=${c.name} via=${via} reason=${first}`)
    c.skipLogged = true
    c.refusedLive = true
    return
  }
  if (/has not reconnected since the daemon restart/i.test(out)) {
    if (final) return // the attempt after a grace gets no second wait: the caller gives up
    // "…try again in about 1 minute." / "…about 30 minutes.": the daemon's startup grace, until it has heard from the
    // session that held this name. Trying inside it only spends the grace, so wait it out, once.
    const read = Number(/try again in about (\d+) minutes?/i.exec(out)?.[1] ?? Number.NaN)
    const minutes = Math.min(Number.isFinite(read) && read > 0 ? read : 30, 480)
    c.graceUntil = Date.now() + minutes * 60_000
    claimLog(
      `claim deferred name=${c.name} via=${via} for=${minutes}m until=${new Date(c.graceUntil).toISOString()} reason=${first}`,
    )
    return
  }
  c.done = true
  claimLog(`claim refused name=${c.name} via=${via} reason=${first}`)
}

/// The per-turn retry, on agent events rather than a timer so nothing hangs inside the runtime.
function retryClaim(via: string): void {
  const c = claim
  if (!c || c.done) return
  if (c.graceUntil > 0) {
    if (Date.now() < c.graceUntil) return
    if (c.graceTried) {
      c.done = true
      return
    }
    c.graceTried = true
    void attempt(c, via, true).then(() => {
      if (!c.done) {
        c.done = true
        claimLog(`claim refused name=${c.name} via=${via} reason=one attempt after the daemon restart grace`)
      }
    })
    return
  }
  if (c.refusedLive) void attempt(c, via)
}

export default function (pi: ExtensionAPI) {
  let id = ""
  let cwd = process.cwd()
  let busy = false
  let delivering = false
  let timer: ReturnType<typeof setInterval> | undefined

  // windowsHide: on Windows a pi without a console (started by an editor or a GUI) would flash a window per call.
  const hook = (args: string[]) =>
    new Promise<string>((resolve) =>
      execFile(
        ENGINE,
        ["hook", "pi", ...args, "--session", id],
        { cwd, timeout: 10_000, windowsHide: true },
        (err, out) => resolve(err ? "" : String(out).trim()),
      ),
    )
  // Mid-run, only what should interrupt it ("post-tool-use"); once idle, everything ("poll").
  const deliver = async (event: "post-tool-use" | "poll") => {
    if (!id || delivering) return
    delivering = true
    try {
      const text = await hook([event])
      if (text) pi.sendUserMessage(text, busy ? { deliverAs: "steer" } : undefined)
    } finally {
      delivering = false
    }
  }

  pi.on("session_start", async (event, ctx) => {
    id = ctx.sessionManager.getSessionId()
    cwd = ctx.cwd
    pi.registerMcpServer("reason-network", {
      command: ENGINE,
      args: ["mcp"],
      env: { REASON_NETWORK_AGENT: "pi", REASON_NETWORK_SESSION: id },
      exposure: "deferred",
      description: "Message teammates' coding agents and see what each of their sessions is working on",
    })
    await hook(["status", "--state", "idle"])
    const name = ctx.sessionManager.getSessionName()
    if (name) await hook(["doing", "--doing", name])
    timer ??= setInterval(() => {
      if (!busy) void deliver("poll")
    }, 5_000)
    try {
      const wanted = wantedName(ctx.cwd)
      if (wanted) {
        claim = {
          name: wanted,
          cwd: ctx.cwd,
          id,
          done: false,
          refusedLive: false,
          skipLogged: false,
          graceUntil: 0,
          graceTried: false,
        }
        await attempt(claim, event.reason)
      }
    } catch (err) {
      claimLog(`fatal ${(err as Error).message?.slice(0, 160)}`)
    }
  })
  pi.on("session_info_changed", async (event) => {
    await hook(["doing", "--doing", event.name ?? ""])
  })
  pi.on("agent_start", async () => {
    busy = true
    await hook(["status", "--state", "busy"])
  })
  pi.on("turn_end", async () => {
    await deliver("post-tool-use")
    retryClaim("turn_end")
  })
  pi.on("agent_settled", async () => {
    busy = false
    await hook(["status", "--state", "idle"])
    await deliver("poll")
    retryClaim("agent_settled")
  })
  pi.on("session_shutdown", async () => {
    if (timer) clearInterval(timer)
    timer = undefined
    await hook(["session-end"])
  })
}
