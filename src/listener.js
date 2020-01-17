'use strict'

const EventEmitter = require('events')
const debug = require('debug')
const log = debug('libp2p:webrtc-star:listener')
log.error = debug('libp2p:webrtc-star:listener:error')

const multiaddr = require('multiaddr')

const io = require('socket.io-client')
const SimplePeer = require('simple-peer')
const pDefer = require('p-defer')

const toConnection = require('./socket-to-conn')
const { cleanUrlSIO } = require('./utils')
const { CODE_P2P } = require('./constants')

const sioOptions = {
  transports: ['websocket'],
  'force new connection': true
}

module.exports = ({ handler, upgrader }, WebRTCStar, options = {}) => {
  const listener = new EventEmitter()

  listener.__connections = []
  listener.listen = (ma) => {
    const defer = pDefer()

    WebRTCStar.maSelf = ma
    const sioUrl = cleanUrlSIO(ma)

    log('Dialing to Signalling Server on: ' + sioUrl)
    listener.io = io.connect(sioUrl, sioOptions)

    const incommingDial = (offer) => {
      if (offer.answer || offer.err) {
        return
      }

      const spOptions = {
        trickle: false,
        ...options
      }

      // Use custom WebRTC implementation
      if (WebRTCStar.wrtc) { spOptions.wrtc = WebRTCStar.wrtc }

      const channel = new SimplePeer(spOptions)

      channel.once('signal', (signal) => {
        offer.signal = signal
        offer.answer = true
        listener.io.emit('ss-handshake', offer)
      })

      channel.signal(offer.signal)

      channel.once('connect', async () => {
        const maConn = toConnection(channel)
        log('new inbound connection %s', maConn.remoteAddr)

        let conn
        try {
          conn = await upgrader.upgradeInbound(maConn)
        } catch (err) {
          log.error('inbound connection failed to upgrade', err)
          return maConn.close()
        }

        if (!conn.remoteAddr) {
          try {
            conn.remoteAddr = ma.decapsulateCode(CODE_P2P).encapsulate(`/p2p/${conn.remotePeer.toString()}`)
          } catch (err) {
            log.error('could not determine remote address', err)
          }
        }

        log('inbound connection %s upgraded', maConn.remoteAddr)

        trackConn(listener, maConn)

        listener.emit('connection', conn)
        handler(conn)
      })
    }

    listener.io.once('connect_error', (err) => defer.reject(err))
    listener.io.once('error', (err) => {
      listener.emit('error', err)
      listener.emit('close')
    })

    listener.io.on('ws-handshake', incommingDial)
    listener.io.on('ws-peer', WebRTCStar._peerDiscovered)

    listener.io.on('connect', () => {
      listener.io.emit('ss-join', ma.toString())
    })

    listener.io.once('connect', () => {
      listener.emit('listening')
      defer.resolve()
    })

    return defer.promise
  }

  listener.close = () => {
    listener.__connections.forEach(maConn => maConn.close())
    listener.io && listener.io.emit('ss-leave')
    listener.emit('close')
  }

  listener.getAddrs = () => {
    return [WebRTCStar.maSelf]
  }

  WebRTCStar.listenersRefs[multiaddr.toString()] = listener
  return listener
}

function trackConn (listener, maConn) {
  listener.__connections.push(maConn)

  const untrackConn = () => {
    listener.__connections = listener.__connections.filter(c => c !== maConn)
  }

  maConn.conn.once('close', untrackConn)
}
