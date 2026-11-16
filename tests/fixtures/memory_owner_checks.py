"""Pinned-owner contract checks; stdlib only, deliberately simulate SDK delete_all false success."""
import enum
import importlib.util
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('along_memory_owner', Path(__file__).resolve().parents[2] / 'scripts/along-memory-service.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class Layer(enum.Enum):
    RAW = 'l1_raw'
    PROFILE = 'l0_basic_info'
    FACT = 'l2_fact'


class Status(enum.Enum):
    ACTIVE = 'active'
    SUPERSEDED = 'superseded'


class OwnerChecks(unittest.TestCase):
    def setUp(self):
        self.owner = module.MemoryOwner.__new__(module.MemoryOwner)
        self.owner.client = Mock()
        self.owner.client.delete_all.return_value = {'success': True}
        self.owner.client.list_memories.return_value = {'vdb': {'memories': [], 'total': 0}}
        self.types = types.ModuleType('hy_memory.models.memory')
        self.types.MemoryLayer, self.types.MemoryStatus = Layer, Status

    def test_cleanup_includes_user_scoped_profiles_and_all_statuses(self):
        with patch.dict(sys.modules, {'hy_memory.models.memory': self.types}):
            self.owner.dispatch('clear', {'userId': 'bound-user'})
        self.owner.client.delete_all.assert_called_once_with(user_id='bound-user')
        read = self.owner.client.list_memories.call_args.kwargs
        self.assertNotIn('agent_id', read)
        self.assertEqual(read['layers'], list(Layer))
        self.assertEqual(read['statuses'], list(Status))

    def test_sdk_success_is_not_accepted_when_profile_is_still_present(self):
        self.owner.client.list_memories.return_value = {'vdb': {'memories': [
            {'memory_id': 'profile', 'content': '撤回的偏好', 'layer': 'l0_basic_info'}], 'total': 1}}
        with patch.dict(sys.modules, {'hy_memory.models.memory': self.types}):
            with self.assertRaisesRegex(RuntimeError, 'incomplete'):
                self.owner.dispatch('clear', {'userId': 'bound-user'})

    def test_sdk_search_shapes_cannot_smuggle_profile_text_as_a_result(self):
        self.owner.client.search.return_value = {'memories': {'l2_fact': [
            {'memory_id': 'first', 'content': 'private fact'}], 'summary': [
            {'node_id': 'second', 'content': 'private summary'}]}}
        self.assertEqual(self.owner.dispatch('search', {'userId': 'bound-user', 'query': 'q', 'limit': 3}), ['first', 'second'])
        self.owner.client.search.assert_called_once_with('q', user_ids=['bound-user'], agent_ids=['along'], scene='chat', limit=3, rerank=False)


if __name__ == '__main__':
    unittest.main()
