import { existsSync, watch } from 'node:fs'

export function startWatcher(guard, { onResult = console.log, onError = console.error } = {}) {
  let watcher = null
  let debounce = null
  let running = false
  let rerun = false
  let stopped = false

  const run = async () => {
    if (stopped) return
    if (running) {
      rerun = true
      return
    }
    running = true
    try {
      onResult(await guard.run({ stable: true }))
    } catch (error) {
      onError(error)
    } finally {
      running = false
      if (rerun) {
        rerun = false
        schedule(0)
      }
    }
  }

  const schedule = (delay = guard.config.debounceMs) => {
    clearTimeout(debounce)
    debounce = setTimeout(run, delay)
  }

  const attach = () => {
    if (watcher || !existsSync(guard.config.root)) return
    try {
      watcher = watch(guard.config.root, { recursive: true }, () => schedule())
      watcher.on('error', (error) => {
        onError(error)
        watcher?.close()
        watcher = null
      })
    } catch (error) {
      onError(error)
      watcher = null
    }
  }

  attach()
  schedule(0)
  const verifyTimer = setInterval(() => {
    attach()
    schedule(0)
  }, guard.config.verifyEveryMs)
  verifyTimer.unref()

  return {
    run,
    stop() {
      stopped = true
      clearTimeout(debounce)
      clearInterval(verifyTimer)
      watcher?.close()
      watcher = null
    },
  }
}
