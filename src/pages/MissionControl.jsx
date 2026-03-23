import { useState, useCallback, useRef } from 'react';
import { getMissionControlState, saveMissionControlState } from '../data/store';
import { defaultTeam } from '../data/defaults';

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

function formatDate(isoString) {
  const diff = Date.now() - new Date(isoString).getTime();
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  return 'Just now';
}

function initState() {
  const saved = getMissionControlState();
  const team = saved.team?.length ? saved.team : defaultTeam;
  const officeStatus =
    saved.officeStatus?.length
      ? saved.officeStatus
      : team.map((m) => ({
          id: m.id, name: m.name, role: m.role, avatar: m.avatar,
          status: m.status,
          currentTask: m.status === 'active' ? 'Building Mission Control dashboard...' : null,
          lastActivity: m.status !== 'idle' ? 'Just now' : '2h ago',
        }));
  let tasks = saved.tasks || [];
  if (tasks.length === 0) {
    tasks = [
      { id: generateId(), title: 'Fix packaging button', description: 'The +New button on packaging page needs fixing', assignee: 'gilbert', status: 'done', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      { id: generateId(), title: 'Build Mission Control dashboard', description: 'Create HTML/JS dashboard for tasks and calendar', assignee: 'gilbert', status: 'in-progress', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      { id: generateId(), title: 'Review co-packing calculator', description: 'Test all functions after bug fixes', assignee: 'me', status: 'todo', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    ];
  }
  return { tasks, cronJobs: saved.cronJobs || [], team, officeStatus };
}

export default function MissionControl() {
  const [state, setState] = useState(initState);
  const [activeTab, setActiveTab] = useState('board');
  const [showForm, setShowForm] = useState(false);
  const [formTitle, setFormTitle] = useState('');
  const [formDesc, setFormDesc] = useState('');
  const [formAssignee, setFormAssignee] = useState('me');
  const [formStatus, setFormStatus] = useState('todo');
  const [notification, setNotification] = useState(null);
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const dragId = useRef(null);

  const persist = useCallback((newState) => {
    setState(newState);
    saveMissionControlState(newState);
  }, []);

  function addTask() {
    if (!formTitle.trim()) return;
    const task = {
      id: generateId(), title: formTitle, description: formDesc,
      assignee: formAssignee, status: formStatus,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    persist({ ...state, tasks: [...state.tasks, task] });
    setFormTitle(''); setFormDesc(''); setShowForm(false);
  }

  function deleteTask(taskId) {
    if (!confirm('Delete this task?')) return;
    persist({ ...state, tasks: state.tasks.filter((t) => t.id !== taskId) });
  }

  function startTask(taskId) {
    const updated = state.tasks.map((t) =>
      t.id === taskId ? { ...t, status: 'in-progress', updatedAt: new Date().toISOString(), startedAt: new Date().toISOString() } : t
    );
    persist({ ...state, tasks: updated });
    const task = updated.find((t) => t.id === taskId);
    showNotification(`Started: ${task.title}`);
  }

  function updateTaskStatus(taskId, newStatus) {
    const updated = state.tasks.map((t) =>
      t.id === taskId ? { ...t, status: newStatus, updatedAt: new Date().toISOString() } : t
    );
    persist({ ...state, tasks: updated });
  }

  function showNotification(message) {
    setNotification(message);
    setTimeout(() => setNotification(null), 3000);
  }

  const todoTasks = state.tasks.filter((t) => t.status === 'todo');
  const inProgressTasks = state.tasks.filter((t) => t.status === 'in-progress');
  const doneTasks = state.tasks.filter((t) => t.status === 'done');

  // Calendar logic
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const month = currentMonth.getMonth();
  const year = currentMonth.getFullYear();
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = new Date();
  const calendarCells = [];
  for (let i = 0; i < firstDay; i++) calendarCells.push(null);
  for (let d = 1; d <= daysInMonth; d++) calendarCells.push(d);

  function handleDragStart(taskId) {
    dragId.current = taskId;
  }

  function handleDrop(newStatus, e) {
    e.preventDefault();
    if (dragId.current) {
      updateTaskStatus(dragId.current, newStatus);
      dragId.current = null;
    }
  }

  function handleDragOver(e) {
    e.preventDefault();
  }

  function TaskCard({ task }) {
    const assigneeLabel = task.assignee === 'me' ? 'Me' : 'Gilbert';
    return (
      <div
        className="task-card"
        draggable
        onDragStart={() => handleDragStart(task.id)}
        onDoubleClick={() => deleteTask(task.id)}
      >
        <div className="task-title">{task.title}</div>
        {task.description && <div className="task-description">{task.description}</div>}
        <div className="task-meta">
          <span className={`task-assignee ${task.assignee === 'me' ? 'assignee-me' : 'assignee-agent'}`}>
            {assigneeLabel}
          </span>
          <span className="task-date">{formatDate(task.createdAt)}</span>
        </div>
        {task.status === 'todo' && (
          <button className="btn btn-primary btn-small" style={{ width: '100%', marginTop: 8, fontSize: 12 }} onClick={() => startTask(task.id)}>
            Start Task
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="mission-control">
      {notification && (
        <div className="mc-notification">{notification}</div>
      )}

      <div className="mc-header">
        <h1>Mission Control</h1>
        <div className="mc-stats">
          <span>Total: {state.tasks.length}</span>
          <span>In Progress: {inProgressTasks.length}</span>
          <span>Done: {doneTasks.length}</span>
        </div>
      </div>

      <div className="mc-tabs">
        {['board', 'calendar', 'cron', 'team', 'office'].map((tab) => (
          <button
            key={tab}
            className={`mc-tab ${activeTab === tab ? 'active' : ''}`}
            onClick={() => setActiveTab(tab)}
          >
            {tab === 'board' ? 'Board' : tab === 'calendar' ? 'Calendar' : tab === 'cron' ? 'Cron Jobs' : tab === 'team' ? 'Team' : 'Office'}
          </button>
        ))}
      </div>

      {/* Board Tab */}
      {activeTab === 'board' && (
        <div className="mc-board">
          <div style={{ marginBottom: 16 }}>
            {!showForm ? (
              <button className="btn btn-primary" onClick={() => setShowForm(true)}>+ Add Task</button>
            ) : (
              <div className="mc-form">
                <input type="text" placeholder="Task title" value={formTitle} onChange={(e) => setFormTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addTask()} />
                <input type="text" placeholder="Description (optional)" value={formDesc} onChange={(e) => setFormDesc(e.target.value)} />
                <div style={{ display: 'flex', gap: 8 }}>
                  <select value={formAssignee} onChange={(e) => setFormAssignee(e.target.value)}>
                    <option value="me">Me</option>
                    <option value="gilbert">Gilbert</option>
                  </select>
                  <select value={formStatus} onChange={(e) => setFormStatus(e.target.value)}>
                    <option value="todo">To Do</option>
                    <option value="in-progress">In Progress</option>
                    <option value="done">Done</option>
                  </select>
                  <button className="btn btn-primary" onClick={addTask}>Save</button>
                  <button className="btn" onClick={() => setShowForm(false)}>Cancel</button>
                </div>
              </div>
            )}
          </div>

          <div className="kanban-board">
            {[
              { status: 'todo', label: 'To Do', tasks: todoTasks },
              { status: 'in-progress', label: 'In Progress', tasks: inProgressTasks },
              { status: 'done', label: 'Done', tasks: doneTasks },
            ].map((col) => (
              <div
                key={col.status}
                className="kanban-column"
                onDragOver={handleDragOver}
                onDrop={(e) => handleDrop(col.status, e)}
              >
                <div className="kanban-header">
                  <span>{col.label}</span>
                  <span className="kanban-count">{col.tasks.length}</span>
                </div>
                <div className="kanban-cards">
                  {col.tasks.map((task) => (
                    <TaskCard key={task.id} task={task} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Calendar Tab */}
      {activeTab === 'calendar' && (
        <div className="mc-calendar">
          <div className="calendar-nav">
            <button className="btn btn-small" onClick={() => setCurrentMonth(new Date(year, month - 1, 1))}>Prev</button>
            <h2>{monthNames[month]} {year}</h2>
            <button className="btn btn-small" onClick={() => setCurrentMonth(new Date(year, month + 1, 1))}>Next</button>
          </div>
          <div className="calendar-grid">
            {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => (
              <div key={d} className="calendar-day-header">{d}</div>
            ))}
            {calendarCells.map((day, idx) => {
              const isToday = day && new Date(year, month, day).toDateString() === today.toDateString();
              return (
                <div key={idx} className={`calendar-cell ${isToday ? 'today' : ''} ${!day ? 'empty' : ''}`}>
                  {day && <div className="calendar-cell-date">{day}</div>}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Cron Jobs Tab */}
      {activeTab === 'cron' && (
        <div className="mc-empty">
          <div style={{ fontSize: 48, marginBottom: 12 }}>⏰</div>
          <p>No scheduled cron jobs found</p>
          <p style={{ fontSize: 12, marginTop: 8 }}>Cron jobs will appear here when created</p>
        </div>
      )}

      {/* Team Tab */}
      {activeTab === 'team' && (
        <div className="team-grid">
          {state.team.map((member) => (
            <div key={member.id} className="team-card">
              <div className="team-avatar">{member.avatar}</div>
              <div className="team-name">{member.name}</div>
              <div className="team-role">{member.role}</div>
              <div className="team-description">{member.description}</div>
              <div className="team-skills">
                {member.skills.map((skill) => (
                  <span key={skill} className="skill-tag">{skill}</span>
                ))}
              </div>
              <div className="team-status">
                <span className={`status-indicator status-${member.status}`} />
                <span>{member.status === 'active' ? 'Active' : member.status === 'busy' ? 'Busy' : 'Idle'}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Office Tab */}
      {activeTab === 'office' && (
        <div className="office-grid">
          {state.officeStatus.map((agent) => {
            const isWorking = agent.status === 'active' || agent.status === 'busy';
            return (
              <div key={agent.id} className="workspace">
                <div className="workspace-header">
                  <div className="workspace-avatar">{agent.avatar}</div>
                  <div className="workspace-info">
                    <div className="workspace-name">{agent.name}</div>
                    <div className="workspace-role">{agent.role}</div>
                  </div>
                </div>
                <div className="workspace-desk">
                  <div className={`desk-screen ${!isWorking ? 'idle' : ''}`}>
                    {isWorking ? (
                      <><span>&gt; {agent.currentTask}</span><span className="typing-indicator">|</span></>
                    ) : (
                      <><span>&gt; System idle...</span><br /><span>&gt; Awaiting tasks</span></>
                    )}
                  </div>
                </div>
                <div className="workspace-activity">
                  <span className={`status-indicator status-${agent.status}`} />
                  <span>{agent.status === 'active' ? 'Working' : agent.status === 'busy' ? 'Busy' : 'Idle'}</span>
                  <span className="activity-time">{agent.lastActivity}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
