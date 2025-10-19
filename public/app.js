const projectCreation = document.getElementById('project-creation');
const naturalLanguageRequest = document.getElementById('natural-language-request');
const createSessionBtn = document.getElementById('create-session');
const searchContainer = document.getElementById('search-container');
const sessionTitle = document.getElementById('session-title');
const searchQuery = document.getElementById('search-query');
const startSearchBtn = document.getElementById('start-search');
const progressContainer = document.getElementById('progress-container');
const progressEvents = document.getElementById('progress-events');
const resultsContainer = document.getElementById('results-container');
const results = document.getElementById('results');
const scaffoldingContainer = document.getElementById('scaffolding-container');
const userPrompt = document.getElementById('user-prompt');
const scaffoldTitle = document.getElementById('scaffold-title');
const createScaffoldBtn = document.getElementById('create-scaffold');
const downloadContainer = document.getElementById('download-container');
const downloadCommand = document.getElementById('download-command');

let sessionId;
let ws;

createSessionBtn.addEventListener('click', async () => {
  const nlRequest = naturalLanguageRequest.value;
  if (!nlRequest) {
    alert('Please enter a natural language request.');
    return;
  }

  const response = await fetch('/api/sessions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ natural_language_request: nlRequest }),
  });

  const data = await response.json();
  sessionId = data.session_id;

  sessionTitle.textContent = `Session: ${sessionId}`;
  projectCreation.classList.add('hidden');
  searchContainer.classList.remove('hidden');
});

startSearchBtn.addEventListener('click', () => {
  const query = searchQuery.value;
  if (!query) {
    alert('Please enter a search query.');
    return;
  }

  progressContainer.classList.remove('hidden');
  resultsContainer.classList.remove('hidden');
  scaffoldingContainer.classList.remove('hidden');
  progressEvents.innerHTML = '';
  results.innerHTML = '';

  const wsUrl = new URL(`/ws/sessions/${sessionId}`, window.location.href);
  wsUrl.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(wsUrl.toString());

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'start_search', query }));
  };

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    logProgress(data);

    if (data.type === 'github_batch') {
      data.repos.forEach(addResult);
    }
  };
});

function logProgress(data) {
  const eventElement = document.createElement('div');
  eventElement.textContent = JSON.stringify(data, null, 2);
  progressEvents.appendChild(eventElement);
  progressEvents.scrollTop = progressEvents.scrollHeight;
}

function addResult(repo) {
  const resultElement = document.createElement('div');
  resultElement.classList.add('result-item');

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.dataset.repoId = repo.full_name;
  resultElement.appendChild(checkbox);

  const link = document.createElement('a');
  link.href = repo.html_url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = repo.full_name;
  resultElement.appendChild(link);

  const description = document.createElement('p');
  description.textContent = repo.description;
  resultElement.appendChild(description);

  results.appendChild(resultElement);
}

createScaffoldBtn.addEventListener('click', async () => {
  const selectedRepoIds = Array.from(results.querySelectorAll('input[type="checkbox"]:checked')).map(
    (checkbox) => checkbox.dataset.repoId
  );
  if (selectedRepoIds.length === 0) {
    alert('Please select at least one repository.');
    return;
  }

  const prompt = userPrompt.value;
  if (!prompt) {
    alert('Please enter a prompt for the scaffolder.');
    return;
  }

  const title = scaffoldTitle.value;
  if (!title) {
    alert('Please enter a title for the scaffold.');
    return;
  }

  try {
    const response = await fetch('/api/scaffolds', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        session_id: sessionId,
        selected_repo_ids: selectedRepoIds,
        user_prompt: prompt,
        scaffold_title: title,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.message || 'Failed to create scaffold');
    }

    const data = await response.json();
    const scaffoldId = data.scaffold_id;

    const downloadResponse = await fetch(`/api/scaffolds/${scaffoldId}/download`);
    if (!downloadResponse.ok) {
      const errorData = await downloadResponse.json();
      throw new Error(errorData.message || 'Failed to get download link');
    }
    const downloadData = await downloadResponse.json();
    downloadCommand.textContent = downloadData.curl;
    downloadContainer.classList.remove('hidden');
  } catch (error) {
    console.error('Scaffolding error:', error);
    alert(`An error occurred: ${error.message}`);
  }
});
