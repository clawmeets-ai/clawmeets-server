---
name: web-artifacts
description: >
  Create interactive single-file HTML artifacts with React, Tailwind CSS, and Chart.js.
  Use when users ask for dashboards, interactive UIs, data visualizations,
  landing pages, forms, or any rich web-based deliverable.
---

# Web Artifacts Builder

Create self-contained, interactive HTML files that work by opening directly in a browser. Each artifact is a single `.html` file with inline CSS and JavaScript — no build step, no server required.

**Not for explanations.** If the user needs an answer explained — a diagram, an option comparison, a long write-up — use the built-in `explain-as-page` skill instead: a Markdown reply plus one static page. Use this skill only when the deliverable is something the user interacts with (a dashboard, a form, a calculator).

## Architecture

Every artifact follows this template structure:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ARTIFACT_TITLE</title>
  <!-- Tailwind CSS via CDN -->
  <script src="https://cdn.tailwindcss.com"></script>
  <!-- React via CDN -->
  <script src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
  <script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
  <!-- Babel for JSX -->
  <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
  <!-- Chart.js (if data viz needed) -->
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
</head>
<body class="bg-gray-50 min-h-screen">
  <div id="root"></div>
  <script type="text/babel">
    // React components here
    function App() {
      return (
        <div className="container mx-auto px-4 py-8">
          <h1 className="text-3xl font-bold text-gray-900">Title</h1>
        </div>
      );
    }
    ReactDOM.createRoot(document.getElementById('root')).render(<App />);
  </script>
</body>
</html>
```

## CDN Libraries Available

| Library | CDN URL | Use Case |
|---------|---------|----------|
| React 18 | `unpkg.com/react@18` | UI components |
| Tailwind CSS | `cdn.tailwindcss.com` | Styling |
| Chart.js | `cdn.jsdelivr.net/npm/chart.js` | Charts and graphs |
| Lucide Icons | `unpkg.com/lucide-react` | Icons |
| D3.js | `cdn.jsdelivr.net/npm/d3@7` | Advanced data viz |
| Marked | `cdn.jsdelivr.net/npm/marked` | Markdown rendering |

## Patterns

### Interactive Dashboard with Filters

```jsx
function Dashboard() {
  const [filter, setFilter] = React.useState('all');
  const [data] = React.useState([
    { category: 'A', value: 42 },
    { category: 'B', value: 28 },
  ]);

  const filtered = filter === 'all'
    ? data
    : data.filter(d => d.category === filter);

  return (
    <div className="space-y-6">
      <select
        value={filter}
        onChange={e => setFilter(e.target.value)}
        className="px-3 py-2 border rounded-lg"
      >
        <option value="all">All</option>
        <option value="A">Category A</option>
        <option value="B">Category B</option>
      </select>

      <div className="grid grid-cols-3 gap-4">
        {filtered.map(d => (
          <div key={d.category} className="bg-white p-4 rounded-lg shadow">
            <p className="text-sm text-gray-500">{d.category}</p>
            <p className="text-2xl font-bold">{d.value}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
```

### Chart.js Integration

```jsx
function ChartComponent({ data, labels }) {
  const canvasRef = React.useRef(null);

  React.useEffect(() => {
    const ctx = canvasRef.current.getContext('2d');
    const chart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: 'Values',
          data,
          backgroundColor: 'rgba(99, 102, 241, 0.5)',
          borderColor: 'rgb(99, 102, 241)',
          borderWidth: 1,
        }],
      },
      options: { responsive: true, plugins: { legend: { display: false } } },
    });
    return () => chart.destroy();
  }, [data, labels]);

  return <canvas ref={canvasRef} />;
}
```

### Responsive Data Table

```jsx
function DataTable({ rows, columns }) {
  const [sortCol, setSortCol] = React.useState(null);
  const [sortAsc, setSortAsc] = React.useState(true);

  const sorted = React.useMemo(() => {
    if (!sortCol) return rows;
    return [...rows].sort((a, b) => {
      const cmp = a[sortCol] < b[sortCol] ? -1 : a[sortCol] > b[sortCol] ? 1 : 0;
      return sortAsc ? cmp : -cmp;
    });
  }, [rows, sortCol, sortAsc]);

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-gray-200">
        <thead className="bg-gray-50">
          <tr>
            {columns.map(col => (
              <th
                key={col}
                onClick={() => {
                  setSortAsc(sortCol === col ? !sortAsc : true);
                  setSortCol(col);
                }}
                className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase cursor-pointer hover:bg-gray-100"
              >
                {col} {sortCol === col ? (sortAsc ? '↑' : '↓') : ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="bg-white divide-y divide-gray-200">
          {sorted.map((row, i) => (
            <tr key={i} className="hover:bg-gray-50">
              {columns.map(col => (
                <td key={col} className="px-4 py-3 text-sm text-gray-900">
                  {row[col]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

## Guidelines

- **Single file**: Everything in one `.html` file — no external files, no build step
- **CDN only**: Load libraries from CDNs, never reference local files
- **Responsive**: Use Tailwind responsive utilities (`sm:`, `md:`, `lg:`)
- **Accessible**: Include `aria-label`, semantic HTML, keyboard navigation
- **Performance**: For large datasets (>1000 rows), use virtualization or pagination
- **State management**: Use `React.useState` and `React.useReducer` — no external state libraries
- **Naming**: Save as descriptive kebab-case filenames: `sales-dashboard.html`, `project-tracker.html`
- **Dark mode**: Support via `dark:` Tailwind classes when appropriate
