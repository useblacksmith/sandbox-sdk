import { SandboxApiError } from "../errors.js";

/**
 * The host's answer for a sandbox it no longer runs: `sandbox_failed`,
 * `sandbox_paused` or `sandbox_deleted` from the socket the agent keeps
 * serving for a few minutes after the VM went. `details.vm_id` names the VM
 * it speaks for, which is not necessarily the one the control plane routes
 * to now, so the control plane's record is the one to trust.
 */
export function isSandboxGone(error: unknown): error is SandboxApiError {
  return (
    error instanceof SandboxApiError &&
    (error.code === "sandbox_failed" ||
      error.code === "sandbox_paused" ||
      error.code === "sandbox_deleted")
  );
}
