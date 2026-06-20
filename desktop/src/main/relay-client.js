const http = require('http')

function postJsonToNode(host, port, body, options = {}) {
  const timeoutMs = Number(options.timeoutMs) || 3500
  const normalizeHost = typeof options.normalizeHost === 'function' ? options.normalizeHost : value => value

  return new Promise(resolve => {
    const data = Buffer.from(JSON.stringify(body), 'utf8')
    const req = http.request({
      hostname: normalizeHost(host),
      port,
      path: options.path || '/relay',
      method: 'POST',
      timeout: timeoutMs,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': data.length
      }
    }, res => {
      const chunks = []
      let total = 0
      res.on('data', chunk => {
        total += chunk.length
        if (total <= 64 * 1024) chunks.push(chunk)
      })
      res.on('end', () => {
        const success = res.statusCode >= 200 && res.statusCode < 300
        if (!success) {
          resolve(false)
          return
        }
        const text = Buffer.concat(chunks).toString('utf8').trim()
        if (!text) {
          resolve(true)
          return
        }
        try {
          const parsed = JSON.parse(text)
          if (parsed && parsed.type === 'bus_ack' && parsed.accepted === false) {
            resolve(false)
            return
          }
        } catch (_) {}
        resolve(true)
      })
    })
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
    req.on('error', () => resolve(false))
    req.write(data)
    req.end()
  })
}

module.exports = {
  postJsonToNode
}
