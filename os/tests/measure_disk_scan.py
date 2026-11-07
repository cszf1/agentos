import importlib.util, tempfile, time, json
from pathlib import Path
from unittest.mock import patch, Mock
spec=importlib.util.spec_from_file_location('installer',str(Path(__file__).resolve().parents[1] / 'installer/agentos-install.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
size=64*1024**3
with tempfile.NamedTemporaryFile(prefix='ui-review-scan-') as f:
    f.truncate(size);f.flush()
    d={'path':f.name,'sizeBytes':size,'partitions':[]}
    actual_open=open
    count=[0]
    class Counted:
        def __enter__(self): self.f=actual_open(f.name,'rb',buffering=0);return self
        def __exit__(self,*args):self.f.close()
        def read(self,n):
            b=self.f.read(n);count[0]+=len(b);return b
    m.open=lambda *a,**k:Counted()
    with patch.object(m.subprocess,'run',return_value=Mock(returncode=2)):
        for variant in ['all-zero','interior-data']:
            if variant=='interior-data':f.seek(8*1024**2);f.write(b'EXISTING RAW DATA');f.flush()
            count[0]=0;t=time.monotonic();result=m.disk_has_data(d);elapsed=time.monotonic()-t
            assert result==(variant=='interior-data')
            assert count[0]==(size if variant=='all-zero' else 16*1024**2)
            print(json.dumps({'variant':variant,'readBytes':count[0],'seconds':round(elapsed,3),'hasData':result,'runs':1,'file':'64GiB sparse file, not block-device throughput'}),flush=True)
