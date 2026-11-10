import { motion } from 'framer-motion';
import { Link } from 'react-router-dom';
import { Card, Page } from '../components/ui';
import { START_STEPS } from '../data/start';
import { RULES_SOURCES } from '../data/rules';

export default function Start() {
  return (
    <Page title="Как начать продавать" subtitle="Шаги из официальной базы знаний FunPay.">
      <ol className="space-y-3">
        {START_STEPS.map((s, i) => (
          <motion.li
            key={s.id}
            className="card flex gap-4 p-5"
            initial={{ opacity: 0, x: -6 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: i * 0.05 }}
          >
            <span className="num grid h-8 w-8 shrink-0 place-items-center rounded-full bg-accent/15 text-sm font-semibold text-accent">{i + 1}</span>
            <div>
              <h2 className="font-medium">{s.title}</h2>
              <ul className="mt-1 space-y-1 text-sm text-muted">
                {s.details.map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </ul>
            </div>
          </motion.li>
        ))}
      </ol>

      <Card title="Дальше в этом приложении">
        <div className="flex flex-wrap gap-2">
          <Link to="/rules" className="btn-ghost">
            Правила и санкции
          </Link>
          <Link to="/calculator" className="btn-ghost">
            Посчитать маржу
          </Link>
          <Link to="/auto-delivery" className="btn-ghost">
            Настроить автовыдачу
          </Link>
          {RULES_SOURCES.map((s) => (
            <a key={s.url} href={s.url} target="_blank" rel="noreferrer" className="btn-ghost">
              {s.label} ↗
            </a>
          ))}
        </div>
      </Card>
    </Page>
  );
}
