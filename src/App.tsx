import { ConversationProvider, useConversationControls, useConversationStatus } from '@elevenlabs/react';
import { Mic, MicOff, Radio, ShieldCheck, Sparkles } from 'lucide-react';
import { useMemo, useState } from 'react';
import './styles.css';

const agentId = import.meta.env.VITE_ELEVENLABS_AGENT_ID;

type LogEntry = {
  label: string;
  tone: 'info' | 'success' | 'error';
};

function VoiceConsole() {
  const { startSession, endSession } = useConversationControls();
  const { status } = useConversationStatus();
  const [logs, setLogs] = useState<LogEntry[]>([
    { label: 'Ready to connect. Grant microphone access when prompted.', tone: 'info' },
  ]);

  const isConnected = status === 'connected';
  const isConnecting = status === 'connecting';

  const statusCopy = useMemo(() => {
    if (isConnected) return 'Live voice session connected';
    if (isConnecting) return 'Connecting to ElevenLabs agent...';
    return 'Idle - waiting to start';
  }, [isConnected, isConnecting]);

  const addLog = (label: string, tone: LogEntry['tone'] = 'info') => {
    setLogs((current) => [{ label, tone }, ...current].slice(0, 5));
  };

  const handleStart = async () => {
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true });
      addLog('Microphone permission granted.', 'success');
      await startSession({
        onConnect: ({ conversationId }) => {
          addLog(`Connected to conversation ${conversationId}.`, 'success');
        },
        onDisconnect: () => {
          addLog('Session ended.', 'info');
        },
        onError: (message) => {
          addLog(`ElevenLabs error: ${message}`, 'error');
        },
      });
    } catch (error) {
      addLog(error instanceof Error ? error.message : 'Unable to start voice session.', 'error');
    }
  };

  return (
    <main className="shell">
      <section className="hero-card">
        <div className="eyebrow"><Sparkles size={16} /> ElevenLabs Agents POC</div>
        <h1>Talk to an AI voice agent from the browser.</h1>
        <p className="lede">
          This proof of concept uses the official ElevenLabs React SDK to open a real-time microphone session
          with your configured agent.
        </p>

        <div className="status-panel" aria-live="polite">
          <div className={`pulse ${isConnected ? 'active' : ''}`} />
          <div>
            <span>Status</span>
            <strong>{statusCopy}</strong>
          </div>
        </div>

        <div className="controls">
          <button className="primary" onClick={handleStart} disabled={isConnected || isConnecting}>
            <Mic size={20} /> Start voice session
          </button>
          <button className="secondary" onClick={() => endSession()} disabled={!isConnected && !isConnecting}>
            <MicOff size={20} /> End session
          </button>
        </div>
      </section>

      <aside className="side-card">
        <div className="detail"><Radio /> <span>Agent ID</span><code>{agentId}</code></div>
        <div className="detail"><ShieldCheck /> <span>Secrets</span><p>API keys stay server-side. Use signed URLs before production.</p></div>
        <div className="log">
          <h2>Event log</h2>
          {logs.map((entry, index) => (
            <p className={entry.tone} key={`${entry.label}-${index}`}>{entry.label}</p>
          ))}
        </div>
      </aside>
    </main>
  );
}

export default function App() {
  if (!agentId || agentId === 'agent_your_agent_id_here') {
    return (
      <main className="missing-config">
        <h1>ElevenLabs agent ID needed</h1>
        <p>Copy <code>.env.example</code> to <code>.env.local</code> and set <code>VITE_ELEVENLABS_AGENT_ID</code>.</p>
      </main>
    );
  }

  return (
    <ConversationProvider agentId={agentId}>
      <VoiceConsole />
    </ConversationProvider>
  );
}
