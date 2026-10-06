import asyncio, json, sys, threading

# Parent messages are UTF-8 JSON even when Windows defaults to another locale.
# This also preserves non-ASCII workspace paths and structured error messages.
sys.stdin.reconfigure(encoding='utf-8')
sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

async def run(request):
    from claude_agent_sdk import ClaudeSDKClient, ClaudeAgentOptions
    options = ClaudeAgentOptions(cwd=request['cwd'], can_use_tool=deny)
    if request['endpoint']['sdk'].get('cliPath'):
        options.cli_path = request['endpoint']['sdk']['cliPath']
    if request['task'].get('model'):
        options.model = request['task']['model']
    client = ClaudeSDKClient(options=options)
    loop = asyncio.get_running_loop()
    cancelled = asyncio.Event()
    def read_cancel():
        for line in sys.stdin:
            try:
                if json.loads(line).get('cancel'):
                    loop.call_soon_threadsafe(cancelled.set)
                    break
            except ValueError:
                pass
    threading.Thread(target=read_cancel, daemon=True).start()
    async def work():
        await client.connect()
        info = await client.get_server_info()
        if not isinstance(info, dict):
            raise RuntimeError('invalid SDK initialize')
        if request.get('probeOnly'):
            return {'protocol':'claude-sdk','handshakeVerified':True,'methods':['connect','get_server_info'],'executionVerified':False}
        await client.query(request['prompt'])
        async for message in client.receive_response():
            if type(message).__name__ == 'ResultMessage':
                ok = message.subtype == 'success' and not message.is_error
                return {'ok':ok,'output':str(message.result or '')[-256000:],'usage':message.usage,'error':'' if ok else 'Claude SDK task failed: '+message.subtype}
        raise RuntimeError('missing terminal result')
    task = asyncio.create_task(work())
    cancel = asyncio.create_task(cancelled.wait())
    try:
        done, _ = await asyncio.wait([task,cancel],timeout=request['task']['timeoutMs']/1000,return_when=asyncio.FIRST_COMPLETED)
        if task not in done:
            try: await asyncio.wait_for(client.interrupt(),1)
            except Exception: pass
            raise RuntimeError('cancelled or timed out')
        return await task
    finally:
        task.cancel(); cancel.cancel()
        await client.disconnect()

async def deny(_name, _input, _context):
    from claude_agent_sdk import PermissionResultDeny
    return PermissionResultDeny(message='Coordinator does not grant additional permissions')

try:
    request=json.loads(sys.stdin.readline())
    print(json.dumps({'result':asyncio.run(run(request))},ensure_ascii=False),flush=True)
except Exception:
    print(json.dumps({'error':'Claude Python SDK调用失败；请核对SDK版本、既有配置和认证','protocolStage':'sdk'},ensure_ascii=False),flush=True)
