export function parseMarkdown(text) {
  if (!text) return '';

  // Process blockquotes BEFORE HTML escaping (they need raw `>`)
  let html = text.replace(/^> (.*$)/gim, '<<<BLOCKQUOTE>>>$1<<<\/BLOCKQUOTE>>>');

  html = html
    // Escape HTML entities to prevent XSS (basic)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

    // Restore blockquotes
    .replace(/<<<BLOCKQUOTE>>>(.*?)<<<\/BLOCKQUOTE>>>/gim, '<blockquote>$1</blockquote>')

    // Headers
    .replace(/^### (.*$)/gim, '<h3>$1</h3>')
    .replace(/^## (.*$)/gim, '<h2>$1</h2>')
    .replace(/^# (.*$)/gim, '<h1>$1</h1>')

    // Bold
    .replace(/\*\*(.*?)\*\*/gim, '<strong>$1</strong>')
    
    // Italic
    .replace(/\*(.*?)\*/gim, '<em>$1</em>')
    .replace(/_(.*?)_/gim, '<em>$1</em>')

    // Code blocks
    .replace(/```([\s\S]*?)```/gim, '<pre><code>$1</code></pre>')

    // Inline code
    .replace(/`([^`]+)`/gim, '<code>$1</code>')

    // Lists (simple)
    .replace(/^\s*[\-\*]\s+(.*)$/gim, '<ul><li>$1</li></ul>')
    .replace(/<\/ul>\n<ul>/gim, '\n') // Merge adjacent lists

    // Paragraphs (double newline to paragraph)
    .replace(/\n\n+/g, '</p><p>')
    .replace(/^(?!<(h[1-6]|ul|ol|li|blockquote|pre|p|div|hr))(.+)$/gim, '<p>$2</p>');

  // Clean up stray paragraph tags
  html = html.replace(/<p><\/p>/g, '');
  
  // Transform timestamps [mm:ss] or [hh:mm:ss]
  html = parseTimestamps(html);

  return html;
}

function timeToSeconds(timeStr) {
  const parts = timeStr.split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return 0;
}

function parseTimestamps(html) {
  return html.replace(/\[(\d{1,2}:\d{2}(?::\d{2})?)\]/g, (match, time) => {
    return `<a href="#" class="timestamp-link" data-time="${timeToSeconds(time)}">${match}</a>`;
  });
}
