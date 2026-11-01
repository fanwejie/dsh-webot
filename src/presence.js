/**
 * Is anybody at this computer?
 *
 * The Host is plain Node: it cannot read the mouse or the keyboard without a native
 * binding, and this plugin deliberately carries no native dependency. Windows
 * exposes the answer through one call — `GetLastInputInfo` returns the tick of the
 * last mouse or keyboard input anywhere on the session, which is exactly "how long
 * has the desk been untouched".
 *
 * That call needs PowerShell. Measured on this machine: ~350 ms per invocation,
 * including the Add-Type compile, which is why it is asked once per finished task
 * and never polled in a loop.
 *
 * Keyboard counts as much as the mouse: someone typing in an editor is at the desk,
 * and a mouse-only check would call them away.
 *
 * @module dsh-webot/presence
 */

import { spawnSync } from 'node:child_process'

/** How long one probe may take before it is abandoned. */
const PROBE_TIMEOUT_MS = 10_000

const PROBE_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class WebotIdle{[StructLayout(LayoutKind.Sequential)]public struct LII{public uint cbSize;public uint dwTime;}[DllImport("user32.dll")]public static extern bool GetLastInputInfo(ref LII p);public static uint IdleMs(){LII i=new LII();i.cbSize=(uint)Marshal.SizeOf(i);if(!GetLastInputInfo(ref i))return 0;return (uint)Environment.TickCount-i.dwTime;}}'
[WebotIdle]::IdleMs()
`

/**
 * Milliseconds since the last keyboard or mouse input, or `null` when the probe
 * cannot run (no PowerShell, non-Windows, policy block).
 *
 * The caller decides what an unknown answer means; this returns the fact, not a
 * verdict.
 */
export function desktopIdleMs() {
  if (process.platform !== 'win32') return null
  try {
    const out = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PROBE_SCRIPT],
      { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, windowsHide: true },
    )
    if (out.status !== 0) return null
    const value = Number(String(out.stdout || '').trim())
    return Number.isFinite(value) && value >= 0 ? value : null
  } catch {
    return null
  }
}
