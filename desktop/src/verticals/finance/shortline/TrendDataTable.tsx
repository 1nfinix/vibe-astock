interface TrendRow {
  date: string;
  value: number | null;
  partial?: boolean;
  missingReason?: string;
}

export function TrendDataTable({ title, unit, rows }: { title: string; unit: string; rows: TrendRow[] }) {
  if (!rows.length) return null;
  return <details className="mt-2">
    <summary className="cursor-pointer rounded py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
      查看数据<span className="sr-only">：{title}</span>
    </summary>
    <table className="w-full text-sm tabular-nums">
      <caption className="sr-only">{title}历史数据</caption>
      <thead><tr className="border-b border-border text-muted-foreground">
        <th scope="col" className="py-1 text-left">日期</th>
        <th scope="col" className="text-right">{title}（{unit}）</th>
      </tr></thead>
      <tbody>{rows.map((row) => <tr key={row.date} className="border-b border-border/40 last:border-0">
        <th scope="row" className="py-1 text-left font-normal">{row.date}</th>
        <td className="text-right">{row.value === null ? row.missingReason ?? "缺数" : row.value.toFixed(2)}{row.partial && "（部分合计）"}</td>
      </tr>)}</tbody>
    </table>
  </details>;
}
