"""Install lifecycle hooks into an existing read-only broker, without changing CLI policy."""
from pathlib import Path
import shutil
import sys


def install(root):
    broker = root / 'private_broker.py'
    source = broker.read_text()
    if 'from broker_lifecycle import serve_broker' not in source:
        source = source.replace('import server\n', 'import server\nfrom broker_lifecycle import serve_broker\n', 1)
        old = 'req=json.loads(line);result=await execute(req)'
        if old not in source:
            raise RuntimeError('BROKER_HANDLER_CHANGED')
        source = source.replace(old, "req=json.loads(line)\n        if req == {'operation':'health'}:result={'ok':True,'status':'ready'}\n        else:result=await execute(req)", 1)
        start = source.index('async def main():')
        source = source[:start] + '''async def main():
    if not os.environ.get('TB_CRED_BINANCE_KEY') or not os.environ.get('TB_CRED_BINANCE_SECRET'):
        raise SystemExit('CREDENTIALS_NOT_CONFIGURED')
    await serve_broker(SOCKET, handle)

if __name__=='__main__':
    if '--daemon' in sys.argv:
        raise SystemExit('Use systemctl start tokenbird-binance-broker')
    asyncio.run(main())
'''
    server = root / 'server.py'
    server_source = server.read_text()
    marker = "'credential_broker_socket_present':Path(__file__).parent.joinpath('run/private.sock').exists(),"
    if "'credential_broker_ready'" not in server_source:
        if marker not in server_source:
            raise RuntimeError('BROKER_CAPABILITIES_CHANGED')
        server_source = server_source.replace(marker, marker + "\n            'credential_broker_ready':await broker_health(),", 1)
        server_source = server_source.replace('from trading import register\n', 'from trading import register, broker_health\n', 1)
    trading = root / 'trading.py'
    trading_source = trading.read_text()
    if 'async def broker_health():' not in trading_source:
        trading_source += '''

async def broker_health():
    """Local process readiness only; never sends an exchange request."""
    writer=None
    try:
        reader,writer=await asyncio.wait_for(asyncio.open_unix_connection(str(SOCKET),limit=4096),2)
        writer.write(b'{"operation":"health"}\\n');await writer.drain()
        result=json.loads(await asyncio.wait_for(reader.readline(),2))
        return result.get('ok') is True and result.get('status')=='ready'
    except Exception:return False
    finally:
        if writer:
            writer.close()
            try:await writer.wait_closed()
            except Exception:pass
'''
    # Validate every transformed module before replacing any live source.
    for path, content in [(broker, source), (server, server_source), (trading, trading_source)]:
        compile(content, str(path), 'exec')
    shutil.copyfile(Path(__file__).with_name('broker_lifecycle.py'), root / 'broker_lifecycle.py')
    for path, content in [(broker, source), (server, server_source), (trading, trading_source)]:
        path.write_text(content)


if __name__ == '__main__':
    install(Path(sys.argv[1]))
