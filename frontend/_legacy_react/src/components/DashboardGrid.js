// frontend/src/components/DashboardGrid.js
import React, { useState } from 'react';

export const INITIAL_WORKSPACES = [
  {
    id: 'hr-01',
    name: 'HR & Onboarding Compliance',
    description: 'Internal payroll policies, employee contracts, and HIPAA benefits compliance.',
    documentCount: 14,
    lastActive: '12 mins ago',
    classification: 'HIPAA Enforced',
    color: '#38bdf8',
    category: 'Human Resources'
  },
  {
    id: 'fin-02',
    name: 'Q3 Financial Audit Pipeline',
    description: 'Quarterly balance sheets, P&L statements, and regulatory tax filings.',
    documentCount: 8,
    lastActive: '1 hour ago',
    classification: 'Strictly Confidential',
    color: '#10b981',
    category: 'Finance'
  },
  {
    id: 'leg-03',
    name: 'Vendor NDA & Contract Review',
    description: 'Mutual non-disclosure agreements, procurement SLA clauses, and IP terms.',
    documentCount: 22,
    lastActive: 'Yesterday',
    classification: 'Legal Privilege',
    color: '#818cf8',
    category: 'Legal'
  },
  {
    id: 'ops-04',
    name: 'SOP Operational Guidelines',
    description: 'Standard operating protocols, client data handling rules, and SOC2 guidelines.',
    documentCount: 5,
    lastActive: '3 days ago',
    classification: 'Internal Only',
    color: '#f59e0b',
    category: 'Operations'
  },
  {
    id: 'med-05',
    name: 'Clinical Patient Records Review',
    description: 'De-identified patient consult notes, diagnostic summaries, and prescription logs.',
    documentCount: 19,
    lastActive: 'Just now',
    classification: 'PHI Isolated',
    color: '#ec4899',
    category: 'Healthcare'
  },
  {
    id: 'merg-06',
    name: 'M&A Due Diligence Room',
    description: 'Acquisition disclosures, valuation models, cap tables, and founder covenants.',
    documentCount: 31,
    lastActive: '4 hours ago',
    classification: 'Executive Only',
    color: '#6366f1',
    category: 'Executive'
  }
];

export default function DashboardGrid({ onSelectWorkspace, onNewWorkspace }) {
  const [filter, setFilter] = useState('All');
  const [workspaces, setWorkspaces] = useState(INITIAL_WORKSPACES);

  const categories = ['All', 'Finance', 'Legal', 'Healthcare', 'Human Resources', 'Operations', 'Executive'];

  const filtered = filter === 'All' 
    ? workspaces 
    : workspaces.filter(ws => ws.category === filter);

  return (
    <div className="dashboard-view">
      <div className="dashboard-header-container">
        <div>
          <h1 className="dashboard-title">Enterprise Workspaces</h1>
          <p className="dashboard-subtitle">
            Select an isolated container environment to begin local DataPrivate computation with zero cloud transmission.
          </p>
        </div>
        <button 
          className="btn btn-primary"
          onClick={() => onNewWorkspace ? onNewWorkspace() : alert("New Workspace modal activated")}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <line x1="12" y1="5" x2="12" y2="19"></line>
            <line x1="5" y1="12" x2="19" y2="12"></line>
          </svg>
          New Secure Workspace
        </button>
      </div>

      <div className="category-chips">
        {categories.map(cat => (
          <button 
            key={cat}
            className={`chip ${filter === cat ? 'active' : ''}`}
            onClick={() => setFilter(cat)}
          >
            {cat}
          </button>
        ))}
      </div>

      <div className="workspace-grid">
        {filtered.map((ws) => (
          <div 
            key={ws.id} 
            className="workspace-card"
            onClick={() => onSelectWorkspace(ws)}
          >
            <div className="card-top">
              <div className="card-icon-wrap" style={{ backgroundColor: `${ws.color}15`, color: ws.color }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
                </svg>
              </div>
              <span className="badge-tag" style={{ color: ws.color, borderColor: `${ws.color}30`, backgroundColor: `${ws.color}10` }}>
                {ws.classification}
              </span>
            </div>

            <div className="card-body">
              <h3 className="card-title">{ws.name}</h3>
              <p className="card-description">{ws.description}</p>
            </div>

            <div className="card-footer">
              <span className="meta-item">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                  <polyline points="14 2 14 8 20 8"></polyline>
                </svg>
                {ws.documentCount} Documents
              </span>
              <span className="meta-time">Active {ws.lastActive}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
