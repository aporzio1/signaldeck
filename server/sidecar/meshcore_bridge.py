#!/usr/bin/env python3
"""MeshCore <-> JSON-lines bridge for SignalDeck.

Speaks the MeshCore companion protocol through the `meshcore` Python package over
TCP or serial. Events go to stdout as JSON lines; commands arrive on stdin.
"""
import argparse
import asyncio
import base64
import json
import queue
import sys
import threading
import time
import traceback

OUT_LOCK = threading.Lock()
QUEUE = queue.Queue()


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
    if hasattr(value, "__dict__"):
        return {str(k): to_json(v, depth + 1) for k, v in vars(value).items() if not k.startswith("_")}
    return str(value)


def contact_json(contact):
    data = to_json(contact) or {}
    if not isinstance(data, dict):
        return {"raw": data}
    return {
        "id": data.get("public_key") or data.get("pubkey") or data.get("id"),
        "name": data.get("adv_name") or data.get("name") or data.get("advName"),
        "type": data.get("type"),
        "lastAdvert": data.get("last_advert") or data.get("lastAdvert"),
        "lastMessage": data.get("last_message") or data.get("lastMessage"),
        "lat": data.get("adv_lat") or data.get("lat"),
        "lon": data.get("adv_lon") or data.get("lon"),
        "outPath": data.get("out_path") or data.get("outPath"),
        "raw": data,
    }


def channel_json(channel, index):
    data = to_json(channel) or {}
    if not isinstance(data, dict):
        return {"index": index, "name": str(data)}
    return {
        "index": data.get("idx", data.get("index", index)),
        "name": data.get("name") or "",
        "secret": bool(data.get("secret")),
        "raw": data,
    }


def get_attr(obj, *names):
    for name in names:
        if hasattr(obj, name):
            return getattr(obj, name)
    return None


class Bridge:
    def __init__(self, args):
        self.args = args
        self.mc = None
        self.commands = None
        self.loop = None
        self.subscribed = set()

    async def connect(self):
        from meshcore import MeshCore

        if self.args.serial:
            creator = get_attr(MeshCore, "create_serial", "create_serial_connection", "serial")
            if creator is None:
                raise RuntimeError("This meshcore version has no serial transport.")
            self.mc = await creator(self.args.serial, baudrate=self.args.baud)
        else:
            creator = get_attr(MeshCore, "create_tcp", "create_tcp_connection", "tcp")
            if creator is None:
                raise RuntimeError("This meshcore version has no TCP transport.")
            self.mc = await creator(self.args.host, self.args.port)

        connect = get_attr(self.mc, "connect")
        if connect:
            result = connect()
            if asyncio.iscoroutine(result):
                await result

        self.commands = get_attr(self.mc, "commands", "cmd")
        if self.commands is None:
            raise RuntimeError("meshcore connected but exposes no command surface.")

        await self.subscribe_events()
        self.mc_self = await self.safe_call("get_self_info", "get_self", "self_info")
        contacts = await self.safe_call("get_contacts", "contacts")
        channels = await self.safe_call("get_channels", "channels")
        emit(
            {
                "type": "ready",
                "self": to_json(self.mc_self),
                "contacts": [contact_json(c) for c in (contacts or [])],
                "channels": [channel_json(c, i) for i, c in enumerate(channels or [])],
            }
        )
        log("connected to MeshCore companion")

    async def safe_call(self, *names, **kwargs):
        for name in names:
            fn = getattr(self.commands, name, None)
            if fn is None:
                continue
            try:
                result = fn(**kwargs) if kwargs else fn()
                if asyncio.iscoroutine(result):
                    result = await result
                return result
            except TypeError:
                continue
            except Exception as exc:
                log("%s failed: %s" % (name, exc), "warn")
                return None
        return None

    async def subscribe_events(self):
        try:
            from meshcore import EventType
        except Exception as exc:
            log("EventType import failed: %s" % exc, "warn")
            return
        subscribe = get_attr(self.mc, "subscribe")
        if subscribe is None:
            log("meshcore client has no subscribe(); live events disabled", "warn")
            return
        mapping = {
            "CONTACT_MSG_RECV": "message",
            "CHANNEL_MSG_RECV": "channel_message",
            "NEW_CONTACT": "contact",
            "CONTACT_UPDATE": "contact",
            "ADVERTISEMENT": "advert",
            "SELF_INFO": "self",
            "BATTERY": "battery",
        }
        for event_name, kind in mapping.items():
            event_type = getattr(EventType, event_name, None)
            if event_type is None:
                continue
            try:
                subscribe(event_type, self.make_handler(kind))
                self.subscribed.add(event_name)
            except Exception as exc:
                log("subscribe %s failed: %s" % (event_name, exc), "warn")
        log("subscribed: %s" % ", ".join(sorted(self.subscribed)))

    def make_handler(self, kind):
        async def handler(event):
            payload = to_json(getattr(event, "payload", event)) or {}
            if kind in ("message", "channel_message"):
                text = ""
                sender = None
                channel = 0
                if isinstance(payload, dict):
                    text = payload.get("text") or payload.get("message") or ""
                    sender = payload.get("pubkey") or payload.get("from") or payload.get("contact")
                    channel = payload.get("channel_idx", payload.get("channel", 0))
                emit(
                    {
                        "type": "message",
                        "kind": "channel" if kind == "channel_message" else "contact",
                        "from": sender,
                        "channel": channel,
                        "text": text,
                        "time": int(time.time()),
                        "payload": payload,
                    }
                )
            elif kind in ("contact", "advert"):
                emit({"type": "contact", "contact": contact_json(payload), "event": kind})
                contacts = await self.safe_call("get_contacts", "contacts")
                if contacts:
                    emit({"type": "contacts", "contacts": [contact_json(c) for c in contacts]})
            elif kind == "battery":
                emit({"type": "battery", "battery": payload})
            elif kind == "self":
                emit({"type": "self", "self": payload})
            else:
                emit({"type": "packet", "event": kind, "payload": payload})

        return handler

    async def run(self):
        while True:
            try:
                await self.connect()
                break
            except Exception as exc:
                emit({"type": "error", "message": "MeshCore connection failed: %s" % exc})
                await asyncio.sleep(6)

        while True:
            try:
                request = QUEUE.get_nowait()
            except queue.Empty:
                await asyncio.sleep(0.2)
                continue
            if request is None:
                return
            await self.handle(request)

    async def handle(self, request):
        cmd = request.get("cmd")
        if cmd == "shutdown":
            raise SystemExit(0)
        try:
            if cmd == "status":
                contacts = await self.safe_call("get_contacts", "contacts")
                channels = await self.safe_call("get_channels", "channels")
                return respond(request, True, {
                    "self": to_json(self.mc_self),
                    "contacts": [contact_json(c) for c in (contacts or [])],
                    "channels": [channel_json(c, i) for i, c in enumerate(channels or [])],
                })
            if cmd == "contacts":
                contacts = await self.safe_call("get_contacts", "contacts")
                return respond(request, True, {"contacts": [contact_json(c) for c in (contacts or [])]})
            if cmd == "channels":
                channels = await self.safe_call("get_channels", "channels")
                return respond(request, True, {"channels": [channel_json(c, i) for i, c in enumerate(channels or [])]})
            if cmd == "send":
                text = request.get("text", "")
                to = request.get("to")
                if to:
                    result = await self.safe_call("send_msg", "send_message", "send_text", contact=to, text=text, message=text)
                else:
                    result = await self.safe_call(
                        "send_chan_msg", "send_channel_msg", "send_channel_text", channel=int(request.get("channel") or 0), text=text, message=text
                    )
                return respond(request, True, {"result": to_json(result)})
            if cmd == "advert":
                return respond(request, True, {"result": to_json(await self.safe_call("send_advert", "advert"))})
            if cmd == "battery":
                return respond(request, True, {"battery": to_json(await self.safe_call("get_battery", "battery"))})
            return respond(request, False, error="Unknown command: %s" % cmd)
        except Exception as exc:
            log("command %s failed: %s" % (cmd, traceback.format_exc(limit=3)), "error")
            return respond(request, False, error=str(exc))


def respond(request, ok, data=None, error=None):
    emit({"type": "response", "id": request.get("id"), "ok": ok, "data": data, "error": error})


def stdin_loop():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            QUEUE.put(json.loads(line))
        except Exception:
            log("invalid command line", "warn")
    QUEUE.put(None)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=5000)
    parser.add_argument("--serial", default=None)
    parser.add_argument("--baud", type=int, default=115200)
    args = parser.parse_args()

    try:
        import meshcore  # noqa: F401
    except Exception as exc:
        emit({"type": "error", "message": "Python meshcore package is missing (%s). Run: pip install meshcore" % exc})
        time.sleep(0.2)
        sys.exit(2)

    threading.Thread(target=stdin_loop, daemon=True).start()
    try:
        asyncio.run(Bridge(args).run())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
