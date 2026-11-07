type AccountSummaryProps = {
  total?: number;
  available?: number;
  loading: boolean;
};

/** 保留四位以内的准确计数，万级数量使用适合窄屏的中文紧凑表示。 */
export function formatAccountCount(value: number) {
  return new Intl.NumberFormat("zh-CN", {
    ...(value >= 10_000
      ? { notation: "compact" as const, maximumSignificantDigits: 2 }
      : { useGrouping: false }),
  }).format(value);
}

/** 展示全部账号的状态概览；加载和缺失数据均不冒充真实的零值。 */
export function AccountSummary({
  total,
  available,
  loading,
}: AccountSummaryProps) {
  const stats = [
    { label: "已接入账号", value: total, tone: "neutral" },
    { label: "可用", value: available, tone: "green" },
    {
      label: "不可用",
      value: total == null || available == null ? undefined : total - available,
      tone: "red",
    },
  ];
  return (
    <section
      className="account-summary"
      aria-label="账号概览"
      aria-busy={loading}
    >
      <dl className="summary-grid">
        {stats.map(({ label, value, tone }) => (
          <div className={`summary-item summary-${tone}`} key={label}>
            <dt>{label}</dt>
            <dd
              title={value == null ? undefined : `${label} ${value} 个`}
              aria-label={
                loading
                  ? `${label}加载中`
                  : `${label} ${value == null ? "暂无数据" : `${value} 个`}`
              }
            >
              {loading ? (
                <span className="summary-placeholder" aria-hidden="true" />
              ) : (
                <>
                  <span className="summary-value" aria-hidden="true">
                    {value == null ? "—" : formatAccountCount(value)}
                  </span>
                  {value != null && <small aria-hidden="true">个</small>}
                </>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
