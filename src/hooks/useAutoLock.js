import { useEffect } from 'react'
import { idleMinutes, shouldAutoLock } from '../utils/idlePolicy.js'

export const IDLE_SETTING = 'vp-idle-minutes'

export function useAutoLock(enabled, onLock) {
  useEffect(() => {
    if (!enabled) return
    let lastActivity = Date.now()
    let hiddenAt = document.hidden ? lastActivity : null
    let locked = false
    const check = () => {
      let minutes = 5
      try { minutes = idleMinutes(localStorage.getItem(IDLE_SETTING)) } catch { /* retain safe default */ }
      if (!locked && shouldAutoLock({ lastActivity, hiddenAt, now: Date.now(), minutes })) {
        locked = true
        onLock()
      }
    }
    const activity = () => { check(); if (!locked && !document.hidden) lastActivity = Date.now() }
    const visibility = () => {
      check()
      if (document.hidden) hiddenAt ??= Date.now()
      else hiddenAt = null
    }
    const events = ['pointerdown', 'pointermove', 'keydown', 'touchstart', 'wheel']
    for (const event of events) window.addEventListener(event, activity, { passive: true })
    document.addEventListener('visibilitychange', visibility)
    const timer = setInterval(check, 1000)
    return () => {
      clearInterval(timer)
      for (const event of events) window.removeEventListener(event, activity)
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [enabled, onLock])
}
