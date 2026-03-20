// Command Palette - Cmd+K Quick Actions
// Usage: CommandPalette.init(commands) where commands is array of {name, description, action, shortcut}

const CommandPalette = {
    commands: [],
    isOpen: false,
    selectedIndex: 0,
    
    init(commands) {
        this.commands = commands;
        this.createUI();
        this.attachListeners();
    },
    
    createUI() {
        // Create overlay
        const overlay = document.createElement('div');
        overlay.id = 'commandPaletteOverlay';
        overlay.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0, 0, 0, 0.5);
            z-index: 10000;
            display: none;
            backdrop-filter: blur(4px);
        `;
        overlay.onclick = () => this.close();
        
        // Create palette
        const palette = document.createElement('div');
        palette.id = 'commandPalette';
        palette.style.cssText = `
            position: fixed;
            top: 20%;
            left: 50%;
            transform: translateX(-50%);
            width: 600px;
            max-width: 90vw;
            background: white;
            border-radius: 12px;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
            display: none;
            z-index: 10001;
        `;
        
        palette.innerHTML = `
            <div style="padding: 16px; border-bottom: 1px solid #e5e7eb;">
                <input 
                    type="text" 
                    id="commandPaletteInput" 
                    placeholder="Type a command or search..."
                    style="width: 100%; padding: 12px 16px; border: none; font-size: 16px; outline: none;"
                    autocomplete="off"
                >
            </div>
            <div id="commandPaletteResults" style="max-height: 400px; overflow-y: auto;">
                <!-- Results populated by JS -->
            </div>
            <div style="padding: 12px 16px; border-top: 1px solid #e5e7eb; background: #f9fafb; font-size: 12px; color: #6b7280; border-bottom-left-radius: 12px; border-bottom-right-radius: 12px;">
                <div style="display: flex; justify-content: space-between;">
                    <div>
                        <kbd style="padding: 2px 6px; background: white; border: 1px solid #d1d5db; border-radius: 4px; font-size: 11px;">↑↓</kbd> Navigate
                        <kbd style="padding: 2px 6px; background: white; border: 1px solid #d1d5db; border-radius: 4px; font-size: 11px; margin-left: 8px;">Enter</kbd> Execute
                    </div>
                    <div>
                        <kbd style="padding: 2px 6px; background: white; border: 1px solid #d1d5db; border-radius: 4px; font-size: 11px;">Esc</kbd> Close
                    </div>
                </div>
            </div>
        `;
        
        document.body.appendChild(overlay);
        document.body.appendChild(palette);
    },
    
    attachListeners() {
        // Cmd+K to open
        document.addEventListener('keydown', (e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
                e.preventDefault();
                this.open();
            }
            
            if (e.key === 'Escape' && this.isOpen) {
                e.preventDefault();
                this.close();
            }
        });
        
        // Input listener
        const input = document.getElementById('commandPaletteInput');
        if (input) {
            input.addEventListener('input', (e) => {
                this.filter(e.target.value);
            });
            
            input.addEventListener('keydown', (e) => {
                if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    this.selectedIndex = Math.min(this.selectedIndex + 1, this.commands.length - 1);
                    this.renderResults(input.value);
                } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    this.selectedIndex = Math.max(this.selectedIndex - 1, 0);
                    this.renderResults(input.value);
                } else if (e.key === 'Enter') {
                    e.preventDefault();
                    this.execute(this.selectedIndex);
                }
            });
        }
    },
    
    open() {
        this.isOpen = true;
        this.selectedIndex = 0;
        document.getElementById('commandPaletteOverlay').style.display = 'block';
        document.getElementById('commandPalette').style.display = 'block';
        document.getElementById('commandPaletteInput').value = '';
        document.getElementById('commandPaletteInput').focus();
        this.renderResults('');
    },
    
    close() {
        this.isOpen = false;
        document.getElementById('commandPaletteOverlay').style.display = 'none';
        document.getElementById('commandPalette').style.display = 'none';
    },
    
    filter(query) {
        this.selectedIndex = 0;
        this.renderResults(query);
    },
    
    renderResults(query) {
        const resultsDiv = document.getElementById('commandPaletteResults');
        const filtered = query ? 
            this.commands.filter(cmd => 
                cmd.name.toLowerCase().includes(query.toLowerCase()) ||
                (cmd.description && cmd.description.toLowerCase().includes(query.toLowerCase()))
            ) : this.commands;
        
        if (filtered.length === 0) {
            resultsDiv.innerHTML = `
                <div style="padding: 40px; text-align: center; color: #9ca3af;">
                    No commands found for "${query}"
                </div>
            `;
            return;
        }
        
        resultsDiv.innerHTML = filtered.map((cmd, index) => {
            const isSelected = index === this.selectedIndex;
            return `
                <div 
                    class="command-item" 
                    data-index="${index}"
                    style="
                        padding: 12px 16px;
                        cursor: pointer;
                        border-bottom: 1px solid #f3f4f6;
                        background: ${isSelected ? '#eff6ff' : 'white'};
                        transition: background 0.1s;
                    "
                    onmouseover="this.style.background='#eff6ff'"
                    onmouseout="this.style.background='${isSelected ? '#eff6ff' : 'white'}'"
                    onclick="CommandPalette.execute(${index})"
                >
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <div>
                            <div style="font-weight: 600; font-size: 14px; margin-bottom: 2px;">${cmd.name}</div>
                            ${cmd.description ? `<div style="font-size: 12px; color: #6b7280;">${cmd.description}</div>` : ''}
                        </div>
                        ${cmd.shortcut ? `<kbd style="padding: 4px 8px; background: #f3f4f6; border: 1px solid #d1d5db; border-radius: 4px; font-size: 11px;">${cmd.shortcut}</kbd>` : ''}
                    </div>
                </div>
            `;
        }).join('');
    },
    
    execute(index) {
        const input = document.getElementById('commandPaletteInput');
        const query = input.value;
        const filtered = query ? 
            this.commands.filter(cmd => 
                cmd.name.toLowerCase().includes(query.toLowerCase()) ||
                (cmd.description && cmd.description.toLowerCase().includes(query.toLowerCase()))
            ) : this.commands;
        
        if (filtered[index]) {
            this.close();
            filtered[index].action();
        }
    }
};
