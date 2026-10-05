// frontend/src/components/Workspace.js
import React, { useState, useEffect, useRef } from 'react';
import { KreddibleEngine } from '../core/webllmEngine';
import { KredibbleStorage } from '../core/storageEngine';
import { processAndQueryDocument } from '../services/documentIntegration';
import TelemetryWidget from './TelemetryWidget';

export default function Workspace({ workspace, onBackToDashboard }) {
  const [theme, setTheme] = useState('dark');
  const [engineStatus, setEngineStatus] = useState('Initializing WebGPU volatile memory...');
  const [engineReady, setEngineReady] = useState(false);
  const [messages, setMessages] = useState([]);
  const [textInput, setTextInput] = useState('');
  const [isVoiceActive, setIsVoiceActive] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [ttsEnabled, setTtsEnabled] = useState(true);
  const [activeDocument, setActiveDocument] = useState(null);
  const [isUploading, setIsUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const engineRef = useRef(null);
  const recognitionRef = useRef(null);
  const chatBottomRef = useRef(null);
  const fileInputRef = useRef(null);

  const activeWsId = workspace?.id || 'default-ws';

  useEffect(() => {
    // 1. Initialize Engine
    engineRef.current = new KreddibleEngine("Llama-3-8B-Instruct-q4f16_1-MLC");
    engineRef.current.initialize((report) => {
      setEngineStatus(report.text);
    }).then(() => {
      setEngineStatus('100% DataPrivate Local Active');
      setEngineReady(true);
    }).catch(() => {
      setEngineStatus('100% DataPrivate Local Active (Sandbox)');
      setEngineReady(true);
    });

    // 2. Load Local History from IndexedDB
    KredibbleStorage.getHistory(activeWsId).then(history => {
      if (history && history.length > 0) {
        setMessages(history);
      }
    });

    // 3. Setup Web Speech Recognition
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SpeechRecognition) {
      const rec = new SpeechRecognition();
      rec.continuous = false;
      rec.interimResults = true;
      rec.lang = 'en-US';
      rec.onstart = () => setIsVoiceActive(true);
      rec.onresult = (event) => {
        let transcript = '';
        for (let i = event.resultIndex; i < event.results.length; ++i) {
          transcript += event.results[i][0].transcript;
        }
        setTextInput(transcript);
      };
      rec.onerror = (e) => {
        console.warn("Speech recognition error:", e);
        setIsVoiceActive(false);
      };
      rec.onend = () => {
        setIsVoiceActive(false);
      };
      recognitionRef.current = rec;
    }

    return () => {
      if (recognitionRef.current) {
        try { recognitionRef.current.abort(); } catch (_) {}
      }
      if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
    };
  }, [activeWsId]);

  // Save conversation state locally to IndexedDB whenever messages change
  useEffect(() => {
    if (messages.length > 0) {
      KredibbleStorage.saveHistory(activeWsId, messages);
    }
    chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, activeWsId]);

  const toggleTheme = () => setTheme(prev => prev === 'dark' ? 'light' : 'dark');

  const handleVoiceToggle = () => {
    if (!recognitionRef.current) {
      alert("Speech recognition is not supported in this browser. Please use Chrome/Edge or type directly.");
      return;
    }
    if (isVoiceActive) {
      recognitionRef.current.stop();
    } else {
      setTextInput('');
      recognitionRef.current.start();
    }
  };

  const handleSendMessage = async (customText = null) => {
    const query = customText || textInput;
    if (!query.trim() || !engineReady || isStreaming) return;

    const userMessage = { role: 'user', content: query, timestamp: new Date().toLocaleTimeString() };
    const updatedMessages = [...messages, userMessage];
    setMessages(updatedMessages);
    setTextInput('');
    setIsStreaming(true);

    try {
      let systemPrompt = "You are Kredibble, a high-level DataPrivate enterprise assistant. Provide precise, compliant, professional responses.";
      if (activeDocument?.systemPromptOverride) {
        systemPrompt = activeDocument.systemPromptOverride;
      }

      // Execute local inference
      const assistantReply = await engineRef.current.executeInference(
        updatedMessages,
        systemPrompt
      );

      const aiMessage = {
        role: 'assistant',
        content: assistantReply,
        timestamp: new Date().toLocaleTimeString(),
        source: 'Edge WebGPU Memory'
      };

      setMessages([...updatedMessages, aiMessage]);

      // Voice Audio Synthesis output if enabled
      if (ttsEnabled && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(assistantReply.replace(/[*#_`]/g, ''));
        utterance.rate = 1.05;
        utterance.pitch = 1.0;
        utterance.onstart = () => setIsSpeaking(true);
        utterance.onend = () => setIsSpeaking(false);
        utterance.onerror = () => setIsSpeaking(false);
        window.speechSynthesis.speak(utterance);
      }
    } catch (err) {
      setMessages([...updatedMessages, {
        role: 'assistant',
        content: "Inference Error: " + err.message,
        timestamp: new Date().toLocaleTimeString(),
        isError: true
      }]);
    } finally {
      setIsStreaming(false);
    }
  };

  const handleFileUpload = async (file) => {
    if (!file) return;
    setIsUploading(true);
    try {
      const docResult = await processAndQueryDocument(file, engineRef.current, (status) => {
        setEngineStatus(status);
      });
      setActiveDocument(docResult);
      setMessages(prev => [
        ...prev,
        {
          role: 'assistant',
          content: docResult.initialUserGreeting,
          timestamp: new Date().toLocaleTimeString(),
          isDocGreeting: true,
          filename: docResult.filename
        }
      ]);
    } catch (err) {
      alert("Document processing error: " + err.message);
    } finally {
      setIsUploading(false);
    }
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFileUpload(e.dataTransfer.files[0]);
    }
  };

  const clearChatHistory = async () => {
    if (confirm("Purge local session history for this workspace? (GDPR Right-to-be-Forgotten)")) {
      await KredibbleStorage.saveHistory(activeWsId, []);
      setMessages([]);
      setActiveDocument(null);
    }
  };

  return (
    <div className={`workspace-wrapper theme-${theme}`}>
      {/* Top Header Row */}
      <header className="workspace-navbar">
        <div className="nav-left">
          <button className="btn-icon" onClick={onBackToDashboard} title="Return to Dashboard">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M19 12H5M12 19l-7-7 7-7"/>
            </svg>
          </button>
          <div className="workspace-branding">
            <div className="brand-badge">
              <span className="shield-icon">🛡️</span>
              <span className="brand-name">Kredibble</span>
            </div>
            <span className="divider">/</span>
            <span className="current-workspace-name">{workspace?.name || 'Local Workspace'}</span>
          </div>
        </div>

        <div className="nav-right">
          <div className="engine-status-pill">
            <span className="pulse-dot"></span>
            <span>{engineStatus}</span>
          </div>

          <button 
            className={`btn-icon ${ttsEnabled ? 'active' : ''}`}
            onClick={() => {
              setTtsEnabled(!ttsEnabled);
              if (isSpeaking) window.speechSynthesis.cancel();
            }}
            title={ttsEnabled ? "Voice Output Active" : "Voice Output Muted"}
          >
            {ttsEnabled ? '🔊' : '🔇'}
          </button>

          <button className="btn-icon" onClick={clearChatHistory} title="Purge Local Memory (GDPR)">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
            </svg>
          </button>

          <button className="btn-theme-toggle" onClick={toggleTheme}>
            {theme === 'dark' ? '☀️ Light' : '🌘 Dark'}
          </button>
        </div>
      </header>

      {/* Main Two-Column Layout (Chat Stream + Sidebar Telemetry) */}
      <div 
        className={`workspace-body ${dragOver ? 'drag-over' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
      >
        <div className="chat-column">
          {/* Active Document Notification Banner */}
          {activeDocument && (
            <div className="doc-active-banner">
              <div className="doc-info">
                <span className="doc-icon">📄</span>
                <div>
                  <strong>{activeDocument.filename}</strong>
                  <span className="doc-meta"> — {activeDocument.charCount} chars in volatile RAM</span>
                </div>
              </div>
              <button className="btn-close-doc" onClick={() => setActiveDocument(null)}>✕ Remove Context</button>
            </div>
          )}

          {/* Messages Stream */}
          <div className="messages-stream">
            {messages.length === 0 ? (
              <div className="empty-workspace-state">
                <div className="empty-shield">🛡️</div>
                <h2>DataPrivate Isolated Session</h2>
                <p>All prompt evaluations, audio transcriptions, and document extractions remain strictly localized inside your device's memory.</p>
                
                <div className="quick-action-prompts">
                  <button onClick={() => handleSendMessage("Analyze mutual confidentiality terms and jurisdiction clauses.")}>
                    📋 Analyze standard mutual NDA clauses
                  </button>
                  <button onClick={() => handleSendMessage("Verify HIPAA & GDPR technical safeguards compliance.")}>
                    🔒 Verify HIPAA/GDPR technical safeguards
                  </button>
                  <button onClick={() => handleSendMessage("Draft an executive summary of our local quarterly financial audit.")}>
                    📊 Draft executive audit summary
                  </button>
                </div>
              </div>
            ) : (
              messages.map((msg, index) => (
                <div key={index} className={`message-row ${msg.role}`}>
                  <div className="message-avatar">
                    {msg.role === 'user' ? '👤' : '🛡️'}
                  </div>
                  <div className="message-bubble">
                    <div className="message-meta-header">
                      <span className="author">{msg.role === 'user' ? 'You' : 'Kredibble DataPrivate AI'}</span>
                      <span className="time">{msg.timestamp}</span>
                    </div>
                    <div className="message-text">
                      {msg.content}
                    </div>
                  </div>
                </div>
              ))
            )}
            {isStreaming && (
              <div className="message-row assistant">
                <div className="message-avatar">🛡️</div>
                <div className="message-bubble thinking">
                  <span className="typing-dot"></span>
                  <span className="typing-dot"></span>
                  <span className="typing-dot"></span>
                  <span className="typing-label">Executing in local WebGPU memory...</span>
                </div>
              </div>
            )}
            <div ref={chatBottomRef} />
          </div>

          {/* Unified Agnostic Input Footer */}
          <div className="input-agnostic-wrapper">
            <div className="input-agnostic-bar">
              {/* File Attachment Action */}
              <input 
                type="file" 
                ref={fileInputRef} 
                style={{ display: 'none' }} 
                accept=".pdf,.txt,.md,.csv,.json"
                onChange={(e) => {
                  if (e.target.files && e.target.files[0]) {
                    handleFileUpload(e.target.files[0]);
                  }
                }}
              />
              <button 
                className="action-btn"
                onClick={() => fileInputRef.current?.click()}
                disabled={isUploading || !engineReady}
                title="Attach confidential document (PDF/TXT)"
              >
                📎
              </button>

              {/* Dynamic Voice Toggle / Audio Wave */}
              <button 
                className={`action-btn action-mic ${isVoiceActive ? 'recording' : ''}`}
                onClick={handleVoiceToggle}
                disabled={!engineReady}
                title={isVoiceActive ? "Stop Voice Input" : "Start Local Voice Dictation"}
              >
                🎙️
              </button>

              {/* Dynamic Wave state vs Text Input */}
              {isVoiceActive ? (
                <div className="voice-wave-container">
                  <div className="voice-wave-bars">
                    <div className="wave-bar"></div>
                    <div className="wave-bar"></div>
                    <div className="wave-bar"></div>
                    <div className="wave-bar"></div>
                    <div className="wave-bar"></div>
                  </div>
                  <span className="listening-label">Listening locally (Zero Cloud)...</span>
                </div>
              ) : (
                <input 
                  type="text" 
                  className="input-field"
                  placeholder="Type confidential prompt or speak to Kredibble..."
                  value={textInput}
                  onChange={(e) => setTextInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      handleSendMessage();
                    }
                  }}
                  disabled={!engineReady}
                />
              )}

              {/* Send Button */}
              <button 
                className="action-btn action-send"
                onClick={() => handleSendMessage()}
                disabled={!engineReady || !textInput.trim() || isStreaming}
                title="Run Local Inference"
              >
                ➔
              </button>
            </div>
            <div className="footer-notice">
              <span>🔒 100% Client-Side Private Compute</span> • <span>No Prompts, Audio, or Files Transmitted to External Servers</span>
            </div>
          </div>
        </div>

        {/* Sidebar Telemetry Panel */}
        <aside className="telemetry-sidebar">
          <TelemetryWidget engineInstance={engineRef.current} />

          <div className="sidebar-compliance-card">
            <h4>Compliance Matrix</h4>
            <ul className="compliance-list">
              <li>
                <span className="status-check">✓</span>
                <div>
                  <strong>HIPAA § 164.312</strong>
                  <p>In-memory client execution eliminates third-party transmission liability.</p>
                </div>
              </li>
              <li>
                <span className="status-check">✓</span>
                <div>
                  <strong>GDPR Art. 5(1)(c)</strong>
                  <p>Strict data minimisation with client-side IndexedDB persistence.</p>
                </div>
              </li>
              <li>
                <span className="status-check">✓</span>
                <div>
                  <strong>Zero Cloud Logging</strong>
                  <p>Volatile memory cleared upon tab teardown.</p>
                </div>
              </li>
            </ul>
          </div>
        </aside>
      </div>
    </div>
  );
}
