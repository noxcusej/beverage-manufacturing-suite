// Mission Control - OpenClaw Dashboard
// Task Board + Calendar + Memory

// ===========================
// Storage & State
// ===========================

const STORAGE_KEY = 'openclaw_mission_control';

let state = {
    tasks: [],
    currentMonth: new Date(),
    cronJobs: [],
    team: [],
    officeStatus: []
};

// Load state from localStorage
function loadState() {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
        const parsed = JSON.parse(saved);
        state.tasks = parsed.tasks || [];
        state.cronJobs = parsed.cronJobs || [];
        state.team = parsed.team || [];
        state.officeStatus = parsed.officeStatus || [];
    }
}

// Save state to localStorage
function saveState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
        tasks: state.tasks,
        cronJobs: state.cronJobs,
        team: state.team,
        officeStatus: state.officeStatus
    }));
}

// ===========================
// Task Management
// ===========================

function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

function addTask(title, description, assignee, status) {
    const task = {
        id: generateId(),
        title,
        description,
        assignee,
        status,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };
    state.tasks.push(task);
    saveState();
    renderTasks();
}

function updateTaskStatus(taskId, newStatus) {
    const task = state.tasks.find(t => t.id === taskId);
    if (task) {
        task.status = newStatus;
        task.updatedAt = new Date().toISOString();
        saveState();
        renderTasks();
    }
}

function deleteTask(taskId) {
    state.tasks = state.tasks.filter(t => t.id !== taskId);
    saveState();
    renderTasks();
}

function startTask(taskId) {
    const task = state.tasks.find(t => t.id === taskId);
    if (task) {
        task.status = 'in-progress';
        task.updatedAt = new Date().toISOString();
        task.startedAt = new Date().toISOString();
        saveState();
        renderTasks();
        
        // Show visual feedback
        showNotification(`Started: ${task.title}`);
    }
}

function showNotification(message) {
    // Simple notification - we can upgrade this later
    const notification = document.createElement('div');
    notification.style.cssText = `
        position: fixed;
        top: 80px;
        right: 20px;
        background: linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%);
        color: white;
        padding: 12px 20px;
        border-radius: 8px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.3);
        z-index: 10000;
        animation: slideIn 0.3s ease;
    `;
    notification.textContent = `✓ ${message}`;
    document.body.appendChild(notification);
    
    setTimeout(() => {
        notification.style.animation = 'slideOut 0.3s ease';
        setTimeout(() => notification.remove(), 300);
    }, 3000);
}

function renderTasks() {
    const todoContainer = document.getElementById('todo-tasks');
    const inProgressContainer = document.getElementById('in-progress-tasks');
    const doneContainer = document.getElementById('done-tasks');

    // Clear containers
    todoContainer.innerHTML = '';
    inProgressContainer.innerHTML = '';
    doneContainer.innerHTML = '';

    // Group tasks by status
    const todoTasks = state.tasks.filter(t => t.status === 'todo');
    const inProgressTasks = state.tasks.filter(t => t.status === 'in-progress');
    const doneTasks = state.tasks.filter(t => t.status === 'done');

    // Render tasks in each column
    todoTasks.forEach(task => todoContainer.appendChild(createTaskCard(task)));
    inProgressTasks.forEach(task => inProgressContainer.appendChild(createTaskCard(task)));
    doneTasks.forEach(task => doneContainer.appendChild(createTaskCard(task)));

    // Update counts
    document.getElementById('todo-count').textContent = todoTasks.length;
    document.getElementById('in-progress-count').textContent = inProgressTasks.length;
    document.getElementById('done-count').textContent = doneTasks.length;

    // Update stats
    document.getElementById('total-tasks').textContent = state.tasks.length;
    document.getElementById('in-progress-tasks').textContent = inProgressTasks.length;
    document.getElementById('completed-tasks').textContent = doneTasks.length;
}

function createTaskCard(task) {
    const card = document.createElement('div');
    card.className = 'task-card';
    card.draggable = true;
    card.dataset.taskId = task.id;

    const assigneeClass = task.assignee === 'me' ? 'assignee-me' : 'assignee-agent';
    const assigneeLabel = task.assignee === 'me' ? 'Me' : 'Gilbert';

    // Add Start button for To Do tasks
    const startButton = task.status === 'todo' ? `
        <button class="btn btn-primary" style="width: 100%; margin-top: 8px; font-size: 12px; padding: 6px 12px;" onclick="startTask('${task.id}')">
            ▶️ Start Task
        </button>
    ` : '';

    card.innerHTML = `
        <div class="task-title">${escapeHtml(task.title)}</div>
        ${task.description ? `<div style="color: #9ca3af; font-size: 12px; margin-top: 4px;">${escapeHtml(task.description)}</div>` : ''}
        <div class="task-meta">
            <span class="task-assignee ${assigneeClass}">${assigneeLabel}</span>
            <span class="task-date">${formatDate(task.createdAt)}</span>
        </div>
        ${startButton}
    `;

    // Drag and drop
    card.addEventListener('dragstart', handleDragStart);
    card.addEventListener('dragend', handleDragEnd);
    
    // Double-click to delete
    card.addEventListener('dblclick', () => {
        if (confirm('Delete this task?')) {
            deleteTask(task.id);
        }
    });

    return card;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function formatDate(isoString) {
    const date = new Date(isoString);
    const now = new Date();
    const diff = now - date;
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ago`;
    if (hours > 0) return `${hours}h ago`;
    return 'Just now';
}

// ===========================
// Drag and Drop
// ===========================

let draggedTask = null;

function handleDragStart(e) {
    draggedTask = this;
    this.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
}

function handleDragEnd(e) {
    this.classList.remove('dragging');
    draggedTask = null;
}

function handleDragOver(e) {
    if (e.preventDefault) {
        e.preventDefault();
    }
    e.dataTransfer.dropEffect = 'move';
    return false;
}

function handleDrop(e, newStatus) {
    if (e.stopPropagation) {
        e.stopPropagation();
    }
    
    if (draggedTask) {
        const taskId = draggedTask.dataset.taskId;
        updateTaskStatus(taskId, newStatus);
    }
    
    return false;
}

// ===========================
// Calendar
// ===========================

function renderCalendar() {
    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December'];
    
    const month = state.currentMonth.getMonth();
    const year = state.currentMonth.getFullYear();
    
    document.getElementById('calendar-month').textContent = `${monthNames[month]} ${year}`;
    
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    
    const cellsContainer = document.getElementById('calendar-cells');
    cellsContainer.innerHTML = '';
    cellsContainer.style.display = 'grid';
    cellsContainer.style.gridTemplateColumns = 'repeat(7, 1fr)';
    cellsContainer.style.gap = '8px';
    
    // Add empty cells for days before month starts
    for (let i = 0; i < firstDay; i++) {
        const emptyCell = document.createElement('div');
        emptyCell.style.aspectRatio = '1';
        cellsContainer.appendChild(emptyCell);
    }
    
    // Add cells for each day
    const today = new Date();
    for (let day = 1; day <= daysInMonth; day++) {
        const cell = document.createElement('div');
        cell.className = 'calendar-cell';
        
        const cellDate = new Date(year, month, day);
        const isToday = cellDate.toDateString() === today.toDateString();
        
        if (isToday) {
            cell.classList.add('today');
        }
        
        cell.innerHTML = `
            <div class="calendar-cell-date">${day}</div>
            <div class="calendar-events"></div>
        `;
        
        cellsContainer.appendChild(cell);
    }
}

function renderCronJobs() {
    const container = document.getElementById('cron-jobs-list');
    
    if (state.cronJobs.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">⏰</div>
                <p>No scheduled cron jobs found</p>
                <p style="font-size: 12px; margin-top: 8px;">Cron jobs will appear here when created via OpenClaw</p>
            </div>
        `;
        return;
    }
    
    container.innerHTML = state.cronJobs.map(job => `
        <div class="task-card" style="margin-bottom: 8px;">
            <div class="task-title">${job.name || 'Unnamed Job'}</div>
            <div style="color: #9ca3af; font-size: 12px; margin-top: 4px;">
                ${job.schedule || 'No schedule'}
            </div>
        </div>
    `).join('');
}

// ===========================
// Tabs
// ===========================

function initTabs() {
    const tabs = document.querySelectorAll('.tab');
    const tabContents = document.querySelectorAll('.tab-content');
    
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const targetTab = tab.dataset.tab;
            
            // Update active tab
            tabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            
            // Update active content
            tabContents.forEach(content => {
                content.classList.remove('active');
            });
            document.getElementById(`${targetTab}-tab`).classList.add('active');
        });
    });
}

// ===========================
// Task Form
// ===========================

function initTaskForm() {
    const addBtn = document.getElementById('add-task-btn');
    const form = document.getElementById('add-task-form');
    const cancelBtn = document.getElementById('cancel-task-btn');
    const saveBtn = document.getElementById('save-task-btn');
    
    addBtn.addEventListener('click', () => {
        form.classList.add('active');
        document.getElementById('task-title').focus();
    });
    
    cancelBtn.addEventListener('click', () => {
        form.classList.remove('active');
        clearForm();
    });
    
    saveBtn.addEventListener('click', () => {
        const title = document.getElementById('task-title').value.trim();
        const description = document.getElementById('task-description').value.trim();
        const assignee = document.getElementById('task-assignee').value;
        const status = document.getElementById('task-status').value;
        
        if (!title) {
            alert('Task title is required');
            return;
        }
        
        addTask(title, description, assignee, status);
        form.classList.remove('active');
        clearForm();
    });
    
    // Enter to save
    document.getElementById('task-title').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            saveBtn.click();
        }
    });
}

function clearForm() {
    document.getElementById('task-title').value = '';
    document.getElementById('task-description').value = '';
    document.getElementById('task-assignee').value = 'me';
    document.getElementById('task-status').value = 'todo';
}

// ===========================
// Calendar Navigation
// ===========================

function initCalendarNavigation() {
    document.getElementById('prev-month').addEventListener('click', () => {
        state.currentMonth.setMonth(state.currentMonth.getMonth() - 1);
        renderCalendar();
    });
    
    document.getElementById('next-month').addEventListener('click', () => {
        state.currentMonth.setMonth(state.currentMonth.getMonth() + 1);
        renderCalendar();
    });
}

// ===========================
// Drag Drop Zones
// ===========================

function initDropZones() {
    const todoZone = document.getElementById('todo-tasks');
    const inProgressZone = document.getElementById('in-progress-tasks');
    const doneZone = document.getElementById('done-tasks');
    
    [todoZone, inProgressZone, doneZone].forEach(zone => {
        zone.addEventListener('dragover', handleDragOver);
    });
    
    todoZone.addEventListener('drop', (e) => handleDrop(e, 'todo'));
    inProgressZone.addEventListener('drop', (e) => handleDrop(e, 'in-progress'));
    doneZone.addEventListener('drop', (e) => handleDrop(e, 'done'));
}

// ===========================
// Team Structure
// ===========================

function initializeTeam() {
    if (state.team.length === 0) {
        state.team = [
            {
                id: 'gilbert',
                name: 'Gilbert',
                role: 'Chief AI Assistant',
                avatar: '🤖',
                description: 'Main agent handling tasks, automation, and coordination. Named after Jordan\'s grandmother\'s butler.',
                skills: ['Task Management', 'Automation', 'Code Generation', 'Data Analysis'],
                status: 'active'
            },
            {
                id: 'dev-agent',
                name: 'DevBot',
                role: 'Development Specialist',
                avatar: '👨‍💻',
                description: 'Handles code reviews, debugging, testing, and deployment automation.',
                skills: ['JavaScript', 'Python', 'React', 'Testing', 'DevOps'],
                status: 'idle'
            },
            {
                id: 'content-agent',
                name: 'ContentCraft',
                role: 'Content Specialist',
                avatar: '✍️',
                description: 'Creates and manages content, documentation, and communications.',
                skills: ['Writing', 'Documentation', 'Copywriting', 'Editing'],
                status: 'idle'
            },
            {
                id: 'data-agent',
                name: 'DataFlow',
                role: 'Data Analyst',
                avatar: '📊',
                description: 'Processes data, generates insights, and creates visualizations.',
                skills: ['Data Analysis', 'Statistics', 'Visualization', 'SQL'],
                status: 'idle'
            },
            {
                id: 'design-agent',
                name: 'DesignLab',
                role: 'Design Specialist',
                avatar: '🎨',
                description: 'Creates UI/UX designs, graphics, and visual content.',
                skills: ['UI/UX', 'Figma', 'CSS', 'Brand Design'],
                status: 'idle'
            },
            {
                id: 'research-agent',
                name: 'ResearchHub',
                role: 'Research Specialist',
                avatar: '🔬',
                description: 'Conducts research, gathers information, and provides analysis.',
                skills: ['Web Research', 'Analysis', 'Summarization', 'Citations'],
                status: 'idle'
            }
        ];
        saveState();
    }
}

function renderTeam() {
    const container = document.getElementById('team-grid');
    
    container.innerHTML = state.team.map(member => {
        const statusClass = member.status === 'active' ? 'status-active' : 
                           member.status === 'busy' ? 'status-busy' : 'status-idle';
        const statusText = member.status === 'active' ? 'Active' :
                          member.status === 'busy' ? 'Busy' : 'Idle';
        
        return `
            <div class="team-card">
                <div class="team-avatar">${member.avatar}</div>
                <div class="team-name">${member.name}</div>
                <div class="team-role">${member.role}</div>
                <div class="team-description">${member.description}</div>
                <div class="team-skills">
                    ${member.skills.map(skill => `<span class="skill-tag">${skill}</span>`).join('')}
                </div>
                <div class="team-status">
                    <span class="status-indicator ${statusClass}"></span>
                    <span>${statusText}</span>
                    ${member.status === 'active' ? '<span style="margin-left: auto; color: #10b981;">●</span>' : ''}
                </div>
            </div>
        `;
    }).join('');
}

// ===========================
// Office View
// ===========================

function initializeOffice() {
    if (state.officeStatus.length === 0) {
        state.officeStatus = state.team.map(member => ({
            id: member.id,
            name: member.name,
            role: member.role,
            avatar: member.avatar,
            status: member.status,
            currentTask: member.status === 'active' ? 'Building Mission Control dashboard...' : 
                        member.status === 'busy' ? 'Processing data...' : null,
            lastActivity: member.status !== 'idle' ? 'Just now' : '2h ago'
        }));
    }
}

function renderOffice() {
    const container = document.getElementById('office-floor');
    container.className = 'office-grid';
    
    container.innerHTML = state.officeStatus.map(agent => {
        const isWorking = agent.status === 'active' || agent.status === 'busy';
        const screenClass = isWorking ? '' : 'idle';
        
        return `
            <div class="workspace">
                <div class="workspace-header">
                    <div class="workspace-avatar">${agent.avatar}</div>
                    <div class="workspace-info">
                        <div class="workspace-name">${agent.name}</div>
                        <div class="workspace-role">${agent.role}</div>
                    </div>
                </div>
                
                <div class="workspace-desk">
                    <div class="desk-screen ${screenClass}">
                        ${isWorking ? `
                            > ${agent.currentTask}
                            <span class="typing-indicator">▋</span>
                        ` : `
                            > System idle...
                            > Awaiting tasks
                        `}
                    </div>
                </div>
                
                <div class="workspace-activity">
                    <span class="status-indicator ${agent.status === 'active' ? 'status-active' : agent.status === 'busy' ? 'status-busy' : 'status-idle'}"></span>
                    <span>${agent.status === 'active' ? 'Working' : agent.status === 'busy' ? 'Busy' : 'Idle'}</span>
                    <span class="activity-time">${agent.lastActivity}</span>
                </div>
            </div>
        `;
    }).join('');
}

// ===========================
// Initialize
// ===========================

document.addEventListener('DOMContentLoaded', () => {
    loadState();
    initTabs();
    initTaskForm();
    initCalendarNavigation();
    initDropZones();
    initializeTeam();
    initializeOffice();
    
    renderTasks();
    renderCalendar();
    renderCronJobs();
    renderTeam();
    renderOffice();
    
});

// Add some sample tasks if none exist
if (state.tasks.length === 0) {
    addTask('Fix packaging button', 'The +New button on packaging page needs fixing', 'gilbert', 'done');
    addTask('Build Mission Control dashboard', 'Create HTML/JS dashboard for tasks and calendar', 'gilbert', 'in-progress');
    addTask('Review co-packing calculator', 'Test all functions after bug fixes', 'me', 'todo');
}

// Make functions globally accessible for onclick handlers
window.startTask = startTask;
