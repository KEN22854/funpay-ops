import { motion } from 'framer-motion';
import { Badge, CopyButton, Page, Warning } from '../components/ui';
import { GOLDEN_KEY_WARNING, TOOLS, TOOLS_WARNING } from '../data/tools';

export default function Tools() {
  return (
    <Page
      title="Инструменты автоматизации"
      subtitle="Справочник сторонних библиотек и ботов. Это не рекомендация: только информация о том, что существует, если решишь автоматизировать рутину."
    >
      <Warning tone="bad">
        <p className="font-medium">{TOOLS_WARNING}</p>
        <p className="text-muted">{GOLDEN_KEY_WARNING}</p>
      </Warning>

      <div className="grid gap-4 md:grid-cols-2">
        {TOOLS.map((t, i) => (
          <motion.article
            key={t.id}
            className="card flex flex-col p-5"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.04 }}
            whileHover={{ scale: 1.01 }}
          >
            <div className="flex items-start justify-between gap-3">
              <h2 className="font-semibold">{t.name}</h2>
              <div className="flex gap-1.5">
                <Badge tone="accent">{t.language}</Badge>
                <Badge tone="muted">{t.source}</Badge>
              </div>
            </div>
            <ul className="mt-3 flex-1 space-y-1 text-sm">
              {t.features.map((f) => (
                <li key={f} className="flex gap-2">
                  <span className="text-muted">·</span>
                  {f}
                </li>
              ))}
            </ul>
            {t.note && <p className="mt-3 text-xs text-muted">{t.note}</p>}
            <div className="mt-4 space-y-2">
              {t.install && (
                <div className="flex items-center gap-2">
                  <code className="num flex-1 truncate rounded-lg border border-line bg-raised px-3 py-2 text-xs">{t.install}</code>
                  <CopyButton text={t.install} label="Скопировать" />
                </div>
              )}
              <a className="block text-sm text-accent hover:underline" href={t.url} target="_blank" rel="noreferrer">
                {t.source === 'PyPI' ? 'Страница на PyPI ↗' : 'Найти на GitHub ↗'}
              </a>
            </div>
          </motion.article>
        ))}
      </div>
    </Page>
  );
}
