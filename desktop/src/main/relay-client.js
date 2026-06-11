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
      res.resume()
      res.on('end', () => resolve(res.statusCode >= 200 && res.statusCode < 300))
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
