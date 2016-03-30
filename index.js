module.exports = WebSocketMirror

var ws = require('ws')
var inherits = require('inherits')

var CONNECTION_CHECK_INTERVAL = 5000 // check the publisher's connection and generate a score every 5 secs
var MIN_REQUIRED_TIMESTAMP_COUNT = CONNECTION_CHECK_INTERVAL / 100
var INITIAL_CONNECTION_SCORE = 5

WebSocketMirror.MESSAGE_TYPE_CONNECTION_SCORE = 1
WebSocketMirror.MESSAGE_TYPE_BROADCAST_START = 2
WebSocketMirror.MESSAGE_TYPE_BROADCAST_PAUSE = 3
WebSocketMirror.MESSAGE_TYPE_BROADCAST_END = 4

inherits(WebSocketMirror, ws.Server)

function WebSocketMirror (httpServer) {
  if (!(this instanceof WebSocketMirror)) {
    return new WebSocketMirror(httpServer)
  }

  ws.Server.call(this, { server: httpServer })
  this.channels = {}
  this._publishers = {}
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
    this._publishers[channel] = socket
    this._publishers[channel]._timestamps = []
    this._publishers[channel]._connectionScore = INITIAL_CONNECTION_SCORE
    this._publishers[channel]._connectionScoreMessage = new Uint8Array([WebSocketMirror.MESSAGE_TYPE_CONNECTION_SCORE, INITIAL_CONNECTION_SCORE])
    this._sendSignalToListeners(WebSocketMirror.MESSAGE_TYPE_BROADCAST_START, channel)
    this._publishers[channel]._timer = setTimeout(this._checkconnection.bind(this, channel), CONNECTION_CHECK_INTERVAL)
    socket.on('close', this._onpublisherclose.bind(this, channel, socket))
    socket.on('message', this._onmessage.bind(this, channel))
  } else if (action === 'subscribe') {
    this.channels[channel] = this.channels[channel] || []
    this.channels[channel].push(socket)
    socket.on('close', this._onsubscriberclose.bind(this, channel, socket))
    socket.on('message', this._oncontrolmessage.bind(this, channel, socket))
  }
}

WebSocketMirror.prototype._sendSignalToListeners = function (signal, channel) {
  var message = new Uint8Array([signal])
  var subscribers = this.channels[channel]
  for (var i in subscribers) {
    try {
      subscribers[i].send(message.buffer)
    } catch (err) {
      console.log(err)
    }
  }
}

WebSocketMirror.prototype._onmessage = function (channel, message) {
  // this may get called by subscribers before there is a publisher,
  // so only add to the publisher's timestamps if the publisher has connected
  this._publishers[channel] && this._publishers[channel]._timestamps.push(Date.now())
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

WebSocketMirror.prototype._checkconnection = function (channel) {
  if (!this._publishers[channel]) return

  var previousTimestamps = this._publishers[channel]._previousTimestamps
  var currentTimestamps = this._publishers[channel]._timestamps
  if (previousTimestamps && currentTimestamps) {
    var diff = previousTimestamps.length - currentTimestamps.length
    var connectionScore = this._publishers[channel]._connectionScore

    if (currentTimestamps.length === 0) {
      console.log('got none since last check')
    } else if (diff > 25) {
      connectionScore -= 5
    } else if (diff > 10) {
      connectionScore -= 4
    } else if (diff > 5) {
      connectionScore -= 3
    } else if (diff > 2) {
      connectionScore -= 2
    } else if (diff === 2) {
      connectionScore -= 1
    } else if (diff === 1) {
      // since the diff was so small, consider it no change
      connectionScore += 0
    } else {
      connectionScore += 1
    }

    // if the publisher hasn't met the minimum, cap their score at 5
    if (currentTimestamps.length < MIN_REQUIRED_TIMESTAMP_COUNT && connectionScore > 5) {
      console.log('minimum not met, only got: ' + currentTimestamps.length)
      connectionScore = 5
    }

    if (connectionScore > 10) {
      connectionScore = 10
    } else if (connectionScore < 0) {
      connectionScore = 0
    }

    // if (diff > 0) {
      // console.log('previous: ' + previousTimestamps.length + ', current: ' + currentTimestamps.length)
      // console.log('score: ' + connectionScore)
    // }
    this._publishers[channel]._connectionScore = connectionScore
    this._publishers[channel]._connectionScoreMessage[1] = connectionScore
    var message = this._publishers[channel]._connectionScoreMessage
    this._publishers[channel].send(message.buffer)
  }

  this._publishers[channel]._previousTimestamps = currentTimestamps
  this._publishers[channel]._timestamps = []

  clearTimeout(this._publishers[channel]._timer)
  this._publishers[channel]._timer = setTimeout(this._checkconnection.bind(this, channel), CONNECTION_CHECK_INTERVAL)
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

WebSocketMirror.prototype._onpublisherclose = function (channel, socket) {
  clearTimeout(this._publishers[channel]._timer)
  delete this._publishers[channel]
  console.log('publisher for channel ' + channel + ' closed')
  this._sendSignalToListeners(WebSocketMirror.MESSAGE_TYPE_BROADCAST_END, channel)
}
