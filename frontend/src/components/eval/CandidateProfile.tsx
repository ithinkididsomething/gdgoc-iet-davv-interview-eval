import type { ReactNode } from 'react';
import type { Candidate, TaskLink } from '../../lib/types';

function LinkList({ links, empty }: { links: TaskLink[]; empty: string }) {
  if (!links || links.length === 0) return <span className="muted">{empty}</span>;
  return (
    <ul className="link-list">
      {links.map((l, i) => (
        <li key={`${l.url}-${i}`}>
          {/* Only rendered when the URL actually came from the workbook / user input. */}
          <a href={l.url} target="_blank" rel="noreferrer noopener">
            {l.label || l.url}
          </a>
        </li>
      ))}
    </ul>
  );
}

function Info({
  label,
  children,
  wide = false,
}: {
  label: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className={wide ? 'profile-wide' : undefined}>
      <span className="label">{label}</span>
      <span className="value">{children}</span>
    </div>
  );
}

/**
 * Expanded applicant profile shown on the evaluation page and in the admin
 * profile dialog: workbook-sourced identity, vertical/shift/priority, links and
 * submitted task.
 */
export function CandidateProfile({
  candidate,
  verticalName,
}: {
  candidate: Candidate;
  verticalName?: string | null;
}) {
  const extraEntries = Object.entries(candidate.source_extra ?? {}).filter(
    ([, v]) => v !== null && v !== undefined && String(v).trim() !== '',
  );
  return (
    <details className="card profile-card" open>
      <summary>
        <strong>Applicant profile</strong>
        <span className="muted"> Identity, links, and submitted work</span>
      </summary>
      <div className="profile-grid">
        <Info label="Vertical">
          {verticalName || candidate.vertical_id ? (
            verticalName ?? 'Assigned'
          ) : (
            <span className="muted">Unassigned</span>
          )}
        </Info>
        <Info label="Shift">{candidate.shift || <span className="muted">—</span>}</Info>
        <Info label="Priority">{candidate.priority ?? <span className="muted">—</span>}</Info>
        <Info label="Email">{candidate.email || <span className="muted">—</span>}</Info>
        <Info label="Roll number">
          {candidate.roll_number || candidate.application_id || <span className="muted">—</span>}
        </Info>
        <Info label="Branch">{candidate.branch || <span className="muted">—</span>}</Info>
        <Info label="Submitted task" wide>
          <LinkList links={candidate.task_links ?? []} empty="No task link recorded" />
        </Info>
        <Info label="External profiles" wide>
          <LinkList links={candidate.external_profiles ?? []} empty="No profiles recorded" />
        </Info>
        <Info label="Message to the team" wide>
          <p style={{ margin: 0 }}>{candidate.team_message || <span className="muted">—</span>}</p>
        </Info>
        <Info label="Remarks" wide>
          <p style={{ margin: 0 }}>{candidate.remarks || <span className="muted">—</span>}</p>
        </Info>
        {extraEntries.length > 0 && (
          <div className="profile-wide">
            <span className="label">Workbook columns (other)</span>
            <div className="profile-extra">
              {extraEntries.map(([k, v]) => (
                <div key={k}>
                  <span className="extra-key">{k}</span>
                  <span className="extra-value">{String(v)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        {(candidate.source_sheet || candidate.last_synced_at || candidate.source_row) && (
          <div className="profile-wide muted source-meta">
            {candidate.source_sheet ? `Source: ${candidate.source_sheet}` : ''}
            {candidate.source_row ? `${candidate.source_sheet ? ' · ' : ''}Row ${candidate.source_row}` : ''}
            {candidate.last_synced_at
              ? `${candidate.source_sheet || candidate.source_row ? ' · ' : ''}Last synced ${new Date(
                  candidate.last_synced_at,
                ).toLocaleString()}`
              : ''}
          </div>
        )}
      </div>
    </details>
  );
}
