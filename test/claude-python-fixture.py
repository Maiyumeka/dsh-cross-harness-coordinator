import json, os
class ClaudeAgentOptions:
    def __init__(self, **values): self.__dict__.update(values)
class PermissionResultDeny:
    def __init__(self, message): self.message=message
class ResultMessage:
    subtype='success'; is_error=False; result='python fixture'; usage={'input_tokens':1}
class ClaudeSDKClient:
    def __init__(self, options): self.options=options
    async def connect(self):
        assert isinstance(await self.options.can_use_tool('fixture',{},None),PermissionResultDeny)
    async def get_server_info(self): return {'models':[]}
    async def query(self, prompt):
        with open(os.path.join(self.options.cwd,'python-prompts.jsonl'),'a',encoding='utf-8') as f: f.write(json.dumps(prompt)+'\n')
        with open(os.path.join(self.options.cwd,'delivery.md'),'w',encoding='utf-8') as f: f.write('Claude Python SDK actual delivery')
    async def receive_response(self): yield ResultMessage()
    async def interrupt(self): pass
    async def disconnect(self): pass
