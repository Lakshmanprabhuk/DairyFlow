"""Unit test for the CRM additions in scripts/dairyflow_data.py (no Microfas export needed).
Run:  python3 tests/test_crm_pipeline.py"""
import importlib.util, json, sys
from pathlib import Path

spec = importlib.util.spec_from_file_location('dairyflow_data', Path(__file__).resolve().parent.parent / 'scripts' / 'dairyflow_data.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)

rel = {'10': {'naam_volledig': 'Anna de Vries'}, '11': {'naam_volledig': 'Bram Jansen'}, '12': {'naam_volledig': ''},
       '13': {'naam_volledig': 'RÃ¡kÃ³czi Zoltan'}}
links = [{'id_rel': '1', 'id_rel__vert': '10'}, {'id_rel': '2', 'id_rel__vert': '10'}, {'id_rel': '2', 'id_rel__vert': '11'},
         {'id_rel': '3', 'id_rel__vert': '12'}, {'id_rel': '3', 'id_rel__vert': '99'},   # unnamed and unknown reps: left out
         {'id_rel': '4', 'id_rel__vert': '13'}, {'id_rel': '4', 'id_rel__vert': '11'}]
keys = [1, 2, '3', 4, 5]
vk = ['Anna de Vries', m.MULTI_REP, m.MULTI_REP, m.MULTI_REP, 'Kantoor']
ref, reps = m.crm_refs(keys, vk, links, rel)

assert ref == ['1', '2', '3', '4', '5'], ref
assert reps == {1: ['Anna de Vries', 'Bram Jansen'], 3: ['Bram Jansen', 'Rákóczi Zoltan']}, reps   # accents repaired, sorted
assert 2 not in reps, 'multi-rep customer with no usable names gets no entry, and nothing raises'
assert 0 not in reps and 4 not in reps, 'single-rep and channel customers never get a rep list'
json.dumps(reps)   # must serialise (int keys become strings, as with contacts)
print('ok: crm_refs')
