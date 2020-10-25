import { EventEmitter } from "events";
import { PacketType } from "socket.io-parser";
import url from "url";
import debugModule from "debug";
import { Server } from "./index";
import { Client } from "./client";
import { Namespace } from "./namespace";
import { IncomingMessage } from "http";
import { Adapter, BroadcastFlags, Room, SocketId } from "socket.io-adapter";
import base64id from "base64id";

const debug = debugModule("socket.io:socket");

export const RESERVED_EVENTS = new Set([
  "error",
  "connect",
  "disconnect",
  "disconnecting",
  // EventEmitter reserved events: https://nodejs.org/api/events.html#events_event_newlistener
  "newListener",
  "removeListener"
]);

/**
 * The handshake details
 */
export interface Handshake {
  /**
   * The headers sent as part of the handshake
   */
  headers: object;

  /**
   * The date of creation (as string)
   */
  time: string;

  /**
   * The ip of the client
   */
  address: string;

  /**
   * Whether the connection is cross-domain
   */
  xdomain: boolean;

  /**
   * Whether the connection is secure
   */
  secure: boolean;

  /**
   * The date of creation (as unix timestamp)
   */
  issued: number;

  /**
   * The request URL string
   */
  url: string;

  /**
   * The query object
   */
  query: object;

  /**
   * The auth object
   */
  auth: object;
}

export class Socket extends EventEmitter {
  public readonly id: SocketId;
  public readonly handshake: Handshake;

  public connected: boolean;
  public disconnected: boolean;

  private readonly server: Server;
  private readonly adapter: Adapter;
  private acks: Map<number, () => void> = new Map();
  private fns: Array<
    (event: Array<any>, next: (err: Error) => void) => void
  > = [];
  private flags: BroadcastFlags = {};
  private _rooms: Set<Room> = new Set();
  private _anyListeners: Array<(...args: any[]) => void>;

  /**
   * Interface to a `Client` for a given `Namespace`.
   *
   * @param {Namespace} nsp
   * @param {Client} client
   * @param {Object} auth
   * @package
   */
  constructor(readonly nsp: Namespace, readonly client: Client, auth: object) {
    super();
    this.server = nsp.server;
    this.adapter = this.nsp.adapter;
    this.id = base64id.generateId(); // don't reuse the Engine.IO id because it's sensitive information
    this.connected = true;
    this.disconnected = false;
    this.handshake = this.buildHandshake(auth);
  }

  /**
   * Builds the `handshake` BC object
   *
   * @private
   */
  private buildHandshake(auth: object): Handshake {
    return {
      headers: this.request.headers,
      time: new Date() + "",
      address: this.conn.remoteAddress,
      xdomain: !!this.request.headers.origin,
      // @ts-ignore
      secure: !!this.request.connection.encrypted,
      issued: +new Date(),
      url: this.request.url,
      query: url.parse(this.request.url, true).query,
      auth
    };
  }

  /**
   * Emits to this client.
   *
   * @return {Socket} self
   * @public
   */
  // @ts-ignore
  public emit(ev: string, ...args: any[]) {
    if (RESERVED_EVENTS.has(ev)) {
      throw new Error(`"${ev}" is a reserved event name`);
    }
    args.unshift(ev);
    const packet: any = {
      type: PacketType.EVENT,
      data: args
    };

    // access last argument to see if it's an ACK callback
    if (typeof args[args.length - 1] === "function") {
      if (this._rooms.size || this.flags.broadcast) {
        throw new Error("Callbacks are not supported when broadcasting");
      }

      debug("emitting packet with ack id %d", this.nsp._ids);
      this.acks.set(this.nsp._ids, args.pop());
      packet.id = this.nsp._ids++;
    }

    const rooms = new Set(this._rooms);
    const flags = Object.assign({}, this.flags);

    // reset flags
    this._rooms.clear();
    this.flags = {};

    if (rooms.size || flags.broadcast) {
      this.adapter.broadcast(packet, {
        except: new Set([this.id]),
        rooms: rooms,
        flags: flags
      });
    } else {
      // dispatch packet
      this.packet(packet, flags);
    }
    return this;
  }

  /**
   * Targets a room when broadcasting.
   *
   * @param {String} name
   * @return {Socket} self
   * @public
   */
  public to(name: Room) {
    this._rooms.add(name);
    return this;
  }

  /**
   * Targets a room when broadcasting.
   *
   * @param {String} name
   * @return {Socket} self
   * @public
   */
  public in(name: Room): Socket {
    this._rooms.add(name);
    return this;
  }

  /**
   * Sends a `message` event.
   *
   * @return {Socket} self
   * @public
   */
  public send(...args): Socket {
    args.unshift("message");
    this.emit.apply(this, args);
    return this;
  }

  /**
   * Sends a `message` event.
   *
   * @return {Socket} self
   * @public
   */
  public write(...args): Socket {
    args.unshift("message");
    this.emit.apply(this, args);
    return this;
  }

  /**
   * Writes a packet.
   *
   * @param {Object} packet - packet object
   * @param {Object} opts - options
   * @private
   */
  private packet(packet, opts: any = {}) {
    packet.nsp = this.nsp.name;
    opts.compress = false !== opts.compress;
    this.client._packet(packet, opts);
  }

  /**
   * Joins a room.
   *
   * @param {String|Array} rooms - room or array of rooms
   * @return a Promise or nothing, depending on the adapter
   * @public
   */
  public join(rooms: Room | Array<Room>): Promise<void> | void {
    debug("join room %s", rooms);

    return this.adapter.addAll(
      this.id,
      new Set(Array.isArray(rooms) ? rooms : [rooms])
    );
  }

  /**
   * Leaves a room.
   *
   * @param {String} room
   * @return a Promise or nothing, depending on the adapter
   * @public
   */
  public leave(room: string): Promise<void> | void {
    debug("leave room %s", room);

    return this.adapter.del(this.id, room);
  }

  /**
   * Leave all rooms.
   *
   * @private
   */
  private leaveAll(): void {
    this.adapter.delAll(this.id);
  }

  /**
   * Called by `Namespace` upon successful
   * middleware execution (ie: authorization).
   * Socket is added to namespace array before
   * call to join, so adapters can access it.
   *
   * @private
   */
  _onconnect(): void {
    debug("socket connected - writing packet");
    this.join(this.id);
    this.packet({ type: PacketType.CONNECT, data: { sid: this.id } });
  }

  /**
   * Called with each packet. Called by `Client`.
   *
   * @param {Object} packet
   * @private
   */
  _onpacket(packet) {
    debug("got packet %j", packet);
    switch (packet.type) {
      case PacketType.EVENT:
        this.onevent(packet);
        break;

      case PacketType.BINARY_EVENT:
        this.onevent(packet);
        break;

      case PacketType.ACK:
        this.onack(packet);
        break;

      case PacketType.BINARY_ACK:
        this.onack(packet);
        break;

      case PacketType.DISCONNECT:
        this.ondisconnect();
        break;

      case PacketType.ERROR:
        this._onerror(new Error(packet.data));
    }
  }

  /**
   * Called upon event packet.
   *
   * @param {Object} packet - packet object
   * @private
   */
  private onevent(packet): void {
    const args = packet.data || [];
    debug("emitting event %j", args);

    if (null != packet.id) {
      debug("attaching ack callback to event");
      args.push(this.ack(packet.id));
    }

    if (this._anyListeners && this._anyListeners.length) {
      const listeners = this._anyListeners.slice();
      for (const listener of listeners) {
        listener.apply(this, args);
      }
    }
    super.emit.apply(this, args);
  }

  /**
   * Produces an ack callback to emit with an event.
   *
   * @param {Number} id - packet id
   * @private
   */
  private ack(id: number) {
    const self = this;
    let sent = false;
    return function() {
      // prevent double callbacks
      if (sent) return;
      const args = Array.prototype.slice.call(arguments);
      debug("sending ack %j", args);

      self.packet({
        id: id,
        type: PacketType.ACK,
        data: args
      });

      sent = true;
    };
  }

  /**
   * Called upon ack packet.
   *
   * @private
   */
  private onack(packet): void {
    const ack = this.acks.get(packet.id);
    if ("function" == typeof ack) {
      debug("calling ack %s with %j", packet.id, packet.data);
      ack.apply(this, packet.data);
      this.acks.delete(packet.id);
    } else {
      debug("bad ack %s", packet.id);
    }
  }

  /**
   * Called upon client disconnect packet.
   *
   * @private
   */
  private ondisconnect(): void {
    debug("got disconnect packet");
    this._onclose("client namespace disconnect");
  }

  /**
   * Handles a client error.
   *
   * @private
   */
  _onerror(err): void {
    if (this.listeners("error").length) {
      super.emit("error", err);
    } else {
      console.error("Missing error handler on `socket`.");
      console.error(err.stack);
    }
  }

  /**
   * Called upon closing. Called by `Client`.
   *
   * @param {String} reason
   * @throw {Error} optional error object
   *
   * @private
   */
  _onclose(reason: string) {
    if (!this.connected) return this;
    debug("closing socket - reason %s", reason);
    super.emit("disconnecting", reason);
    this.leaveAll();
    this.nsp._remove(this);
    this.client._remove(this);
    this.connected = false;
    this.disconnected = true;
    super.emit("disconnect", reason);
  }

  /**
   * Produces an `error` packet.
   *
   * @param {Object} err - error object
   *
   * @private
   */
  _error(err) {
    this.packet({ type: PacketType.ERROR, data: err });
  }

  /**
   * Disconnects this client.
   *
   * @param {Boolean} close - if `true`, closes the underlying connection
   * @return {Socket} self
   *
   * @public
   */
  public disconnect(close = false): Socket {
    if (!this.connected) return this;
    if (close) {
      this.client._disconnect();
    } else {
      this.packet({ type: PacketType.DISCONNECT });
      this._onclose("server namespace disconnect");
    }
    return this;
  }

  /**
   * Sets the compress flag.
   *
   * @param {Boolean} compress - if `true`, compresses the sending data
   * @return {Socket} self
   * @public
   */
  public compress(compress: boolean): Socket {
    this.flags.compress = compress;
    return this;
  }

  /**
   * Sets a modifier for a subsequent event emission that the event data may be lost if the client is not ready to
   * receive messages (because of network slowness or other issues, or because they’re connected through long polling
   * and is in the middle of a request-response cycle).
   *
   * @return {Socket} self
   * @public
   */
  public get volatile(): Socket {
    this.flags.volatile = true;
    return this;
  }

  /**
   * Sets a modifier for a subsequent event emission that the event data will only be broadcast to every sockets but the
   * sender.
   *
   * @return {Socket} self
   * @public
   */
  public get broadcast(): Socket {
    this.flags.broadcast = true;
    return this;
  }

  /**
   * Sets a modifier for a subsequent event emission that the event data will only be broadcast to the current node.
   *
   * @return {Socket} self
   * @public
   */
  public get local(): Socket {
    this.flags.local = true;
    return this;
  }

  /**
   * A reference to the request that originated the underlying Engine.IO Socket.
   *
   * @public
   */
  public get request(): IncomingMessage {
    return this.client.request;
  }

  /**
   * A reference to the underlying Client transport connection (Engine.IO Socket object).
   *
   * @public
   */
  public get conn() {
    return this.client.conn;
  }

  /**
   * @public
   */
  public get rooms(): Set<Room> {
    return this.adapter.socketRooms(this.id) || new Set();
  }

  /**
   * Adds a listener that will be fired when any event is emitted. The event name is passed as the first argument to the
   * callback.
   *
   * @param listener
   * @public
   */
  public onAny(listener: (...args: any[]) => void): Socket {
    this._anyListeners = this._anyListeners || [];
    this._anyListeners.push(listener);
    return this;
  }

  /**
   * Adds a listener that will be fired when any event is emitted. The event name is passed as the first argument to the
   * callback. The listener is added to the beginning of the listeners array.
   *
   * @param listener
   * @public
   */
  public prependAny(listener: (...args: any[]) => void): Socket {
    this._anyListeners = this._anyListeners || [];
    this._anyListeners.unshift(listener);
    return this;
  }

  /**
   * Removes the listener that will be fired when any event is emitted.
   *
   * @param listener
   * @public
   */
  public offAny(listener?: (...args: any[]) => void): Socket {
    if (!this._anyListeners) {
      return this;
    }
    if (listener) {
      const listeners = this._anyListeners;
      for (let i = 0; i < listeners.length; i++) {
        if (listener === listeners[i]) {
          listeners.splice(i, 1);
          return this;
        }
      }
    } else {
      this._anyListeners = [];
    }
    return this;
  }

  /**
   * Returns an array of listeners that are listening for any event that is specified. This array can be manipulated,
   * e.g. to remove listeners.
   *
   * @public
   */
  public listenersAny() {
    return this._anyListeners || [];
  }
}