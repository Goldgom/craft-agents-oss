import asyncio
import os
import signal
import socket
import stat
import tempfile
import unittest
from pathlib import Path
from broker_lifecycle import BrokerAlreadyRunning, clear_stale_socket, serve_broker


class LifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def test_stale_socket_removed_but_files_and_links_preserved(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'private.sock'
            with socket.socket(socket.AF_UNIX) as client:
                client.bind(str(path))
            await clear_stale_socket(path)
            self.assertFalse(path.exists())
            path.write_text('preserve')
            with self.assertRaises(RuntimeError):
                await clear_stale_socket(path)
            self.assertEqual(path.read_text(), 'preserve')
            path.unlink()
            target = Path(temp) / 'target'
            target.write_text('preserve')
            path.symlink_to(target)
            with self.assertRaises(RuntimeError):
                await clear_stale_socket(path)
            self.assertTrue(path.is_symlink())

    async def test_live_socket_is_not_unlinked(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'private.sock'
            async def close(reader, writer):
                writer.close()
                await writer.wait_closed()
            server = await asyncio.start_unix_server(close, str(path))
            try:
                with self.assertRaises(BrokerAlreadyRunning):
                    await clear_stale_socket(path)
                self.assertTrue(path.exists())
            finally:
                server.close()
                await server.wait_closed()

    async def test_singleton_permissions_and_shutdown_cleanup(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'run' / 'private.sock'
            async def close(reader, writer):
                writer.close()
                await writer.wait_closed()
            serving = asyncio.create_task(serve_broker(path, close))
            try:
                for _ in range(100):
                    if path.exists():
                        break
                    await asyncio.sleep(0.01)
                self.assertTrue(path.exists())
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
                self.assertEqual(stat.S_IMODE(path.parent.stat().st_mode), 0o700)
                with self.assertRaises(BrokerAlreadyRunning):
                    await serve_broker(path, close)
                self.assertTrue(path.exists())
                os.kill(os.getpid(), signal.SIGTERM)
                await asyncio.wait_for(serving, 2)
                self.assertFalse(path.exists())
            finally:
                if not serving.done():
                    serving.cancel()
                    with self.assertRaises(asyncio.CancelledError):
                        await serving


if __name__ == '__main__':
    unittest.main()
