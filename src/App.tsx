import { useCallback, useState } from 'react';
import CameraScreen from './components/CameraScreen';
import ResultScreen from './components/ResultScreen';
import type { Capture } from './types';
import { QA_ENABLED } from './qa/qa';

export default function App() {
  const [capture, setCapture] = useState<Capture | null>(null);
  // 기본은 '남이 보는 방향'(반전 없음)
  const [mirror, setMirror] = useState(false);
  const onCapture = useCallback((c: Capture) => setCapture(c), []);
  const [reference, setReference] = useState<Capture | null>(null);

  return (
    <main className="app">
      <header>
        <h1>남이 보는 내 얼굴</h1>
        {QA_ENABLED && <span className="qa-badge">검증 빌드</span>}
      </header>
      {capture ? (
        <ResultScreen
          capture={capture}
          mirror={mirror}
          onMirrorChange={setMirror}
          onRetake={() => setCapture(null)}
          reference={reference}
          onSetReference={setReference}
        />
      ) : (
        <CameraScreen mirror={mirror} onMirrorChange={setMirror} onCapture={onCapture} />
      )}
    </main>
  );
}
