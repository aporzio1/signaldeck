#!/usr/bin/env python3
"""Meshtastic <-> JSON-lines bridge for SignalDeck.

Connects to a local meshtasticd over TCP (port 4403), emits events on stdout and
accepts commands as JSON lines on stdin. Every line is a complete JSON object so
the Node service can multiplex safely from either Python thread.
"""
import argparse
import base64
import json
import queue
import sys
import threading
import time
import traceback

OUT_LOCK = threading.Lock()


def emit(obj):
    with OUT_LOCK:
        sys.stdout.write(json.dumps(obj, default=str) + "\n")
        sys.stdout.flush()


def log(message, level="info"):
    emit({"type": "log", "level": level, "message": str(message)[:1000]})


def to_json(value, depth=0):
    if depth > 5:
        return None
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, bytes):
        return base64.b64encode(value).decode()
    if isinstance(value, dict):
        return {str(k): to_json(v, depth + 1) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [to_json(v, depth + 1) for v in list(value)[:300]]
    if hasattr(value, "ListFields"):
        return {field.name: to_json(val, depth + 1) for field, val in value.ListFields()}
    if hasattr(value, "__dict__"):
        return {str(k): to_json(v, depth + 1) for k, v in vars(value).items() if not k.startswith("_")}
    return str(value)


def node_json(node):
    node = node or {}
    user = node.get("user") or {}
    pos = node.get("position") or {}
    metrics = node.get("deviceMetrics") or {}
    return {
        "num": node.get("num"),
        "id": user.get("id") or node.get("user", {}).get("id"),
        "longName": user.get("longName") or user.get("id"),
        "shortName": user.get("shortName"),
        "hwModel": user.get("hwModel"),
        "role": to_json(user.get("role")),
        "snr": node.get("snr"),
        "lastHeard": node.get("lastHeard"),
        "hopsAway": node.get("hopsAway"),
        "viaMqtt": node.get("viaMqtt"),
        "latitude": pos.get("latitude"),
        "longitude": pos.get("longitude"),
        "altitude": pos.get("altitude"),
        "positionTime": pos.get("time"),
        "battery": metrics.get("batteryLevel"),
        "voltage": metrics.get("voltage"),
        "channelUtilization": metrics.get("channelUtilization"),
        "airUtilTx": metrics.get("airUtilTx"),
        "uptimeSeconds": metrics.get("uptimeSeconds"),
    }


def channel_json(channel, index):
    try:
        settings = channel.settings
        return {
            "index": index,
            "name": settings.name or "",
            "role": to_json(channel.role),
            "psk": base64.b64encode(settings.psk).decode() if settings.psk else "",
            "uplinkEnabled": bool(channel.uplink_enabled),
            "downlinkEnabled": bool(channel.downlink_enabled),
        }
    except Exception:
        return {"index": index, "name": "", "role": None, "psk": "", "uplinkEnabled": False, "downlinkEnabled": False}


def my_info(interface):
    info = getattr(interface, "myInfo", None)
    data = to_json(info) or {}
    metadata = to_json(getattr(interface, "metadata", None)) or {}
    node = getattr(interface, "localNode", None)
    user = to_json(getattr(node, "user", None)) or {}
    return {
        "myNodeNum": data.get("myNodeNum"),
        "deviceId": data.get("deviceId") or user.get("id"),
        "firmware": metadata.get("firmwareVersion"),
        "hwModel": metadata.get("hwModel") or user.get("hwModel"),
        "longName": user.get("longName"),
        "shortName": user.get("shortName"),
        "nodeId": user.get("id"),
        "hasWifi": metadata.get("hasWifi"),
    }


def read_config(interface):
    node = interface.localNode
    lora = node.localConfig.lora
    device = node.localConfig.device
    return {
        "region": int(getattr(lora, "region", 0)),
        "modemPreset": int(getattr(lora, "modem_preset", 0)),
        "txPower": int(getattr(lora, "tx_power", 0)),
        "hopLimit": int(getattr(lora, "hop_limit", 0)),
        "txEnabled": bool(getattr(lora, "tx_enabled", True)),
        "role": int(getattr(device, "role", 0)),
        "nodeInfoBroadcastSecs": int(getattr(lora, "node_info_broadcast_secs", 0)),
        "frequencyOffset": float(getattr(lora, "frequency_offset", 0)),
        "overrideFrequency": float(getattr(lora, "override_frequency", 0)),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=4403)
    args = parser.parse_args()

    try:
        import meshtastic
        import meshtastic.tcp_interface
        from pubsub import pub
    except Exception as exc:
        emit({"type": "error", "message": "Python meshtastic package is missing (%s). Re-run install.sh." % exc})
        time.sleep(0.2)
        sys.exit(2)

    commands = queue.Queue()
    interface = {"iface": None, "ready": False}

    def on_receive(packet, iface):
        try:
            decoded = packet.get("decoded") or {}
            portnum = str(decoded.get("portnum") or "")
            from_id = packet.get("fromId")
            nodes = getattr(iface, "nodes", {}) or {}
            sender = nodes.get(from_id) or {}
            user = sender.get("user") or {}
            to_id = packet.get("toId") or ""
            base = {
                "id": packet.get("id"),
                "from": from_id,
                "fromName": user.get("longName") or from_id,
                "to": to_id,
                "channel": packet.get("channel", 0),
                "time": packet.get("rxTime", int(time.time())),
                "snr": packet.get("snr"),
                "hops": packet.get("hopsAway"),
                "portnum": portnum,
                "direct": bool(to_id and not to_id.startswith("^")),
            }
            if portnum == "TEXT_MESSAGE_APP" or decoded.get("text"):
                base.update({"type": "message", "text": decoded.get("text", "")})
                emit(base)
            elif decoded.get("position"):
                pos = to_json(decoded["position"])
                emit({"type": "node", "node": node_json({**sender, "position": pos})})
            elif decoded.get("telemetry"):
                emit({"type": "node", "node": node_json(sender)})
            else:
                emit({"type": "packet", "packet": base})
        except Exception:
            log("receive handler error: " + traceback.format_exc(limit=2), "error")

    def on_node_updated(node, interface=None):
        try:
            emit({"type": "node", "node": node_json(to_json(node) or node)})
        except Exception:
            pass

    def on_connection(iface=None, topic=None):
        try:
            interface["iface"] = iface
            interface["ready"] = True
            node_dict = {k: to_json(v) for k, v in (getattr(iface, "nodes", {}) or {}).items()}
            emit(
                {
                    "type": "ready",
                    "myInfo": my_info(iface),
                    "nodes": [node_json(n) for n in node_dict.values()],
                    "channels": [channel_json(c, i) for i, c in enumerate(getattr(iface.localNode, "channels", []))],
                }
            )
            try:
                emit({"type": "config", "config": read_config(iface)})
            except Exception as exc:
                log("config read failed: %s" % exc, "warn")
            log("connected to meshtasticd")
        except Exception:
            log("connection handler error: " + traceback.format_exc(limit=2), "error")

    def on_lost(interface=None, topic=None):
        interface["ready"] = False
        emit({"type": "error", "message": "Connection to meshtasticd lost."})

    pub.subscribe(on_receive, "meshtastic.receive")
    pub.subscribe(on_node_updated, "meshtastic.node.updated")
    pub.subscribe(on_connection, "meshtastic.connection.established")
    pub.subscribe(on_lost, "meshtastic.connection.lost")

    stdin_thread = threading.Thread(target=stdin_loop, args=(commands,), daemon=True)
    stdin_thread.start()

    iface = None
    last_attempt = 0
    while True:
        if iface is None and time.time() - last_attempt > 5:
            last_attempt = time.time()
            try:
                iface = meshtastic.tcp_interface.TCPInterface(
                    hostname=args.host, portNumber=args.port, connectNow=True
                )
            except Exception as exc:
                iface = None
                emit({"type": "error", "message": "Cannot reach meshtasticd at %s:%s (%s)" % (args.host, args.port, exc)})

        try:
            request = commands.get(timeout=0.5)
        except queue.Empty:
            continue
        if request is None:
            break
        handle(request, iface, interface, pub)


def stdin_loop(commands):
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            commands.put(json.loads(line))
        except Exception:
            log("invalid command line", "warn")
    commands.put(None)


def respond(request, ok, data=None, error=None):
    emit({"type": "response", "id": request.get("id"), "ok": ok, "data": data, "error": error})


def handle(request, iface, state, pub):
    cmd = request.get("cmd")
    if cmd == "shutdown":
        try:
            if iface:
                iface.close()
        finally:
            sys.exit(0)
    if cmd == "status":
        if not iface:
            return respond(request, False, error="meshtasticd is not reachable.")
        return respond(
            request,
            True,
            {
                "myInfo": my_info(iface),
                "config": read_config(iface),
                "nodes": len(getattr(iface, "nodes", {}) or {}),
                "channels": [channel_json(c, i) for i, c in enumerate(getattr(iface.localNode, "channels", []))],
            },
        )
    if not iface:
        return respond(request, False, error="meshtasticd is not reachable. Start the service first.")

    try:
        if cmd == "send":
            text = request.get("text", "")
            kwargs = {"wantAck": True}
            channel = int(request.get("channel") or 0)
            to = request.get("to")
            if to:
                kwargs["destinationId"] = to
            else:
                kwargs["channelIndex"] = channel
            iface.sendText(text, **kwargs)
            return respond(request, True, {"sent": text})

        if cmd == "nodes":
            nodes = [node_json(to_json(n) or n) for n in (getattr(iface, "nodes", {}) or {}).values()]
            return respond(request, True, {"nodes": nodes})

        if cmd == "channels":
            channels = [channel_json(c, i) for i, c in enumerate(getattr(iface.localNode, "channels", []))]
            return respond(request, True, {"channels": channels})

        if cmd == "config":
            return respond(request, True, {"config": read_config(iface)})

        if cmd == "setConfig":
            section = request.get("section") or "lora"
            key = request.get("key")
            value = request.get("value")
            mapping = {
                "region": "region",
                "preset": "modem_preset",
                "modemPreset": "modem_preset",
                "txPower": "tx_power",
                "hopLimit": "hop_limit",
                "txEnabled": "tx_enabled",
                "role": "role",
            }
            attribute = mapping.get(key, key)
            target = iface.localNode.localConfig.device if attribute == "role" else iface.localNode.localConfig.lora
            if not hasattr(target, attribute):
                return respond(request, False, error="Unknown setting %s" % key)
            setattr(target, attribute, type(getattr(target, attribute))(value))
            iface.localNode.writeConfig(section)
            time.sleep(0.4)
            return respond(request, True, {"config": read_config(iface)})

        if cmd == "setChannel":
            index = int(request.get("index") or 0)
            channel = iface.localNode.channels[index]
            if request.get("name") is not None:
                channel.settings.name = str(request["name"])[:11]
            psk = request.get("psk")
            if psk is not None:
                channel.settings.psk = base64.b64decode(psk) if psk else b""
            write_channel = getattr(iface.localNode, "writeChannel", None)
            if write_channel is None:
                return respond(request, False, error="This meshtastic library cannot write channels.")
            write_channel(index)
            time.sleep(0.4)
            channels = [channel_json(c, i) for i, c in enumerate(iface.localNode.channels)]
            return respond(request, True, {"channels": channels})

        if cmd == "requestPosition":
            node = request.get("to")
            iface.sendPosition(destinationId=node) if node else iface.sendPosition()
            return respond(request, True, {})

        if cmd == "traceroute":
            target = request.get("to")
            result = iface.sendTraceRoute(target, hopLimit=int(request.get("hopLimit") or 3))
            return respond(request, True, {"result": to_json(result)})

        if cmd == "advert":
            return respond(request, True, {"result": to_json(iface.localNode.getURL())})

        if cmd == "reboot":
            iface.localNode.reboot()
            return respond(request, True, {})

        return respond(request, False, error="Unknown command: %s" % cmd)
    except Exception as exc:
        log("command %s failed: %s" % (cmd, traceback.format_exc(limit=3)), "error")
        return respond(request, False, error=str(exc))


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
