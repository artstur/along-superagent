#!/usr/bin/env python3
"""Exercise Hy-Memory with synthetic data; offline mode tests plumbing, not model quality."""
import argparse
from contextlib import contextmanager
import importlib.metadata
import json
import logging
import os
from pathlib import Path
import tempfile
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--offline', action='store_true', help='use deterministic HTTP responses; make no model requests')
parser.add_argument('--env-file', type=Path, help='local credentials file; never printed or copied')
args = parser.parse_args()

if args.env_file:
    from dotenv import load_dotenv
    load_dotenv(args.env_file, override=True)
if not args.offline:
    required = ['MEMORY_LLM_API_KEY', 'MEMORY_LLM_BASE_URL', 'MEMORY_LLM_MODEL',
                'MEMORY_EMBEDDER_API_KEY', 'MEMORY_EMBEDDER_BASE_URL', 'MEMORY_EMBEDDER_MODEL']
    missing = [key for key in required if not os.environ.get(key)]
    if missing:
        parser.error('Missing configuration names: ' + ', '.join(missing))

artifact_root = Path(__file__).resolve().parents[1] / '.artifacts' / 'along-phase0'
artifact_root.mkdir(parents=True, exist_ok=True)
data_dir = Path(tempfile.mkdtemp(prefix='memory-probe-', dir=artifact_root))
os.environ.update(MEMORY_DATA_DIR=str(data_dir), MEMORY_ENABLE_GRAPH='false',
                  MEMORY_ENABLE_INTENTION='false', MEMORY_CODING_ENABLED='false',
                  MEMORY_ENABLE_QUERY_REWRITE='false', MEMORY_LANGUAGE='zh-Hans',
                  MEMORY_LOG_LLM_CONTENT='false', ANONYMIZED_TELEMETRY='false',
                  MEMORY_EMBEDDER_BATCH_SIZE='10')
if args.offline:
    os.environ.update(MEMORY_LLM_API_KEY='synthetic', MEMORY_EMBEDDER_API_KEY='synthetic',
                      MEMORY_LLM_BASE_URL='https://phase0.invalid/v1',
                      MEMORY_EMBEDDER_BASE_URL='https://phase0.invalid/v1',
                      MEMORY_LLM_MODEL='phase0-extractor', MEMORY_EMBEDDER_MODEL='text-embedding-v4')

import httpx
import kuzu
from hy_memory import HyMemoryClient
from hy_memory.config import MemoryConfig
from hy_memory.utils.pipeline_observability import drain_pipeline_log_tasks

logging.disable(logging.INFO)
calls = {'embeddings': 0, 'llm': 0}
dimensions = int(os.environ.get('MEMORY_EMBEDDING_DIMS', '1024'))
fact = '用户明确表示喜欢在晚饭前散步。'

def respond(request):
    body = json.loads(request.content)
    if request.url.path.endswith('/embeddings'):
        calls['embeddings'] += 1
        assert body.get('dimensions') == dimensions
        items = body['input'] if isinstance(body['input'], list) else [body['input']]
        assert len(items) <= 10
        payload = {'object': 'list', 'model': body['model'], 'usage': {'prompt_tokens': 1, 'total_tokens': 1},
                   'data': [{'object': 'embedding', 'index': i, 'embedding': [1.0] + [0.0] * (dimensions - 1)} for i in range(len(items))]}
    elif request.url.path.endswith('/chat/completions'):
        calls['llm'] += 1
        prompt = json.dumps(body['messages'], ensure_ascii=False)
        content = ([{'op': 'ADD', 'content': fact, 'owner': 'user', 'tags': ['运动'], 'reason': '合成探针'}]
                   if 'SUPERSEDE' in prompt else {'memory': [{'content': fact, 'owner': 'user', 'tags': ['运动']}], 'intentions': [], 'basic_info': {}})
        payload = {'id': 'phase0-synthetic', 'object': 'chat.completion', 'model': body['model'],
                   'choices': [{'index': 0, 'finish_reason': 'stop', 'message': {'role': 'assistant', 'content': json.dumps(content, ensure_ascii=False)}}],
                   'usage': {'prompt_tokens': 1, 'completion_tokens': 1, 'total_tokens': 2}}
    else:
        raise AssertionError('Unexpected offline HTTP path')
    return httpx.Response(200, json=payload)

def config():
    value = MemoryConfig.from_env()
    value.enable_graph = False
    value.embedder.embedding_dims = dimensions
    value.vector_store.embedding_dims = dimensions
    value.embedder.batch_size = 10
    if args.offline:
        value.http_transport_factory = lambda: httpx.MockTransport(respond)
    return value

@contextmanager
def memory_client():
    client = HyMemoryClient(config=config(), mode='pro')
    try:
        yield client
    finally:
        # Pinned SDK 2.0.16's close() does not drain its queued pipeline logs.
        # The probe bridges to both owner loops before closing their cache.
        try:
            for loop in {client._search_loop_thread, client._loop_thread}:
                loop.run(drain_pipeline_log_tasks(timeout=5))
        finally:
            client.close()

started = time.monotonic()
db = kuzu.Database(str(data_dir / 'native-kuzu'), buffer_pool_size=16 * 1024 * 1024)
conn = kuzu.Connection(db)
assert conn.execute('RETURN 1').get_next() == [1]
conn.close()
db.close()

identity = {'user_id': 'along-phase0-user', 'agent_id': 'along', 'scene': 'chat'}
with memory_client() as client:
    added = client.add('我明确喜欢在晚饭前散步。', **identity, meta={'event_id': 'phase0-synthetic-1'})
    if not added.get('success', False):
        raise RuntimeError('Synthetic add did not report success')
    recalled = client.search('用户喜欢什么时候散步？', user_ids=[identity['user_id']], agent_ids=['along'], scene='chat')
    assert any(recalled.get('memories', {}).values()), 'No memory recalled after add'
with memory_client() as reopened:
    recalled = reopened.search('用户喜欢什么时候散步？', user_ids=[identity['user_id']], agent_ids=['along'], scene='chat')
    assert any(recalled.get('memories', {}).values()), 'No memory recalled after reopen'

print(json.dumps({'mode': 'offline-transport' if args.offline else 'live',
                  'hy_memory': importlib.metadata.version('hy-memory'), 'dimensions': dimensions,
                  'kuzu_native_query': True, 'add_search_reopen': True,
                  'offline_calls': calls if args.offline else None,
                  'seconds': round(time.monotonic() - started, 3)}, ensure_ascii=False))
