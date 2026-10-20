"""Linux foreground lifecycle. Never reads, persists or logs credentials."""
import asyncio
import contextlib
import fcntl
import os
import signal
import socket
import stat


class BrokerAlreadyRunning(RuntimeError):
    pass


def notify(message):
    target = os.environ.get('NOTIFY_SOCKET')
    if not target:
        return
    if target.startswith('@'):
        target = '\0' + target[1:]
    with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as client:
        client.sendto(message.encode(), target)


async def clear_stale_socket(path):
    try:
        info = path.lstat()
    except FileNotFoundError:
        return
    if not stat.S_ISSOCK(info.st_mode):
        raise RuntimeError('SOCKET_PATH_IS_NOT_A_SOCKET')
    try:
        _, writer = await asyncio.wait_for(asyncio.open_unix_connection(str(path)), 2)
    except (ConnectionRefusedError, FileNotFoundError):
        # Never remove a replacement installed while we were checking.
        try:
            current = path.lstat()
        except FileNotFoundError:
            return
        if (current.st_dev, current.st_ino) != (info.st_dev, info.st_ino):
            raise RuntimeError('SOCKET_CHANGED_DURING_CHECK')
        path.unlink()
        return
    writer.close()
    await writer.wait_closed()
    raise BrokerAlreadyRunning('BROKER_ALREADY_RUNNING')


async def serve_broker(path, handler):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(path.parent, 0o700)
    lock = os.open(str(path) + '.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    server = None
    identity = None
    heartbeat = None
    loop = asyncio.get_running_loop()
    stop = asyncio.Event()
    installed_signals = []
    try:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise BrokerAlreadyRunning('BROKER_ALREADY_RUNNING') from None
        await clear_stale_socket(path)
        server = await asyncio.start_unix_server(handler, str(path), limit=8192)
        os.chmod(path, 0o600)
        info = path.lstat()
        identity = (info.st_dev, info.st_ino)
        for sig in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(sig, stop.set)
            installed_signals.append(sig)

        async def watchdog():
            interval = min(5, max(0.1, int(os.environ.get('WATCHDOG_USEC', '30000000')) / 3_000_000))
            while True:
                notify('WATCHDOG=1')
                await asyncio.sleep(interval)

        notify('READY=1\nSTATUS=Read-only credential broker ready')
        heartbeat = asyncio.create_task(watchdog())
        # A failed heartbeat must terminate the service rather than go unnoticed.
        stopped = asyncio.create_task(stop.wait())
        try:
            done, _ = await asyncio.wait([stopped, heartbeat], return_when=asyncio.FIRST_COMPLETED)
            if heartbeat in done:
                heartbeat.result()
        finally:
            stopped.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await stopped
    finally:
        for sig in installed_signals:
            loop.remove_signal_handler(sig)
        if heartbeat:
            heartbeat.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await heartbeat
        if server:
            server.close()
            await server.wait_closed()
        if identity:
            try:
                info = path.lstat()
                if (info.st_dev, info.st_ino) == identity:
                    path.unlink()
            except FileNotFoundError:
                pass
        os.close(lock)
