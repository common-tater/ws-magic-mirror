module.exports = WebSocketMirror

var ws = require('ws')
var inherits = require('inherits')

inherits(WebSocketMirror, ws.Server)

function WebSocketMirror (httpServer) {
  if (!(this instanceof WebSocketMirror)) {
    return new WebSocketMirror(httpServer)
  }

  ws.Server.call(this, { server: httpServer })
  this.channels = {}
  this.on('connection', this._onconnection.bind(this))
}

WebSocketMirror.prototype._onconnection = function (socket) {
  // give each connecting peer an id that we can track them by
  socket._hyperId = String(Math.random()).slice(2)
  console.log('connected ' + socket._hyperId)
  var path = socket.upgradeReq.url.slice(1).split('/')
  if (path.length < 2) return socket.close()
  var channel = path[0]
  var action = path[1]
  if (action === 'publish') {
    socket.on('message', this._onmessage.bind(this, channel))
  } else if (action === 'subscribe') {
    this.channels[channel] = this.channels[channel] || []
    this.channels[channel].push(socket)
    socket.on('close', this._onsubscriberclose.bind(this, channel, socket))
    socket.on('message', this._oncontrolmessage.bind(this, channel, socket))
  }
}

WebSocketMirror.prototype._onmessage = function (channel, message) {
  var subscribers = this.channels[channel]
  for (var i in subscribers) {
    if (subscribers[i]._paused) continue

    try {
      subscribers[i].send(message)
    } catch (err) {}
  }
}

WebSocketMirror.prototype._oncontrolmessage = function (channel, socket, controlMessage) {
  var subscribers = this.channels[channel]
  for (var i in subscribers) {
    if (subscribers[i] === socket) {
      var paused = controlMessage === '-'
      subscribers[i]._paused = paused
      return
    }
  }
}

WebSocketMirror.prototype._onsubscriberclose = function (channel, socket) {
  this.channels[channel] = this.channels[channel].filter(function (s) {
    return s !== socket
  })
  console.log('subscriber closed, num left: ' + Object.keys(this.channels[channel]).length)
  if (Object.keys(this.channels[channel]).length === 0) {
    delete this.channels[channel]
  }
}
