export const DEFAULT_IDLE_MINUTES = 5
export const HIDDEN_LOCK_MS = 10 * 60 * 1000

export function idleMinutes(value) {
  const minutes = Number(value)
  return Number.isInteger(minutes) && minutes >= 1 && minutes <= 60 ? minutes : DEFAULT_IDLE_MINUTES
}

export function shouldAutoLock({ lastActivity, hiddenAt, now, minutes = DEFAULT_IDLE_MINUTES }) {
  return (hiddenAt !== null && now - hiddenAt >= HIDDEN_LOCK_MS) ||
    now - lastActivity >= idleMinutes(minutes) * 60 * 1000
}
