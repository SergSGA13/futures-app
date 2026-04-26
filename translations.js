// ===== TRANSLATIONS =====
const i18n = {

// ==================== RUSSIAN ====================
ru: {
  'nav.home':'Главная','nav.signals':'Сигналы','nav.stats':'Статистика','nav.articles':'Статьи',
  'home.sub':'Торговые сигналы · Стратегии · Обучение',
  'menu.fp.sub':'Сигналы · Правила · Стратегия входа',
  'menu.fs.title':'Futures Strategy','menu.fs.sub':'Торговые стратегии · Бектесты',
  'menu.ind.title':'Индикаторы','menu.ind.sub':'TradingView индикаторы',
  'menu.art.title':'Статьи','menu.art.sub':'Психология · Обучение',
  'stats.label':'Статистика сигналов','stats.more':'Подробнее ›',
  'stats.wr7d':'WinRate Last 7 Day','stats.sig7d':'Signals Last 7 Day',
  'stats.wrall':'WinRate Total','stats.sigall':'Signals Total',
  'link.main':'Основной канал','link.chat':'Чат сообщества','btn.refresh':'Обновить',
  'title.fp':'Futures Prediction','title.fs':'Futures Strategy',
  'title.ind':'Индикаторы','title.art':'Статьи','title.stats':'Статистика',
  'title.stats.l30d':'Last 30 Days','title.stats.all':'ALL Periods',
  'sig.today':'Сигналы сегодня','sig.group.btn':'Signals Group',
  'sig.empty':'Сигналов сегодня нет','sig.loading':'Загрузка...','sig.error':'Ошибка загрузки',
  'sig.sum.total':'Всего','sig.ago.h':'ч','sig.ago.m':'м','sig.ago.s':'с','sig.ago.word':'назад',
  'warn.title':'🔴 Важное предупреждение',
  'warn.text':'Стратегия <strong>НЕ работает</strong> на сильных трендах и импульсах без откатов!',
  'warn.1':'Цена движется импульсно без откатов',
  'warn.2':'Происходят сильные безоткатные движения',
  'warn.3':'Рынок находится в активном тренде',
  'prin.title':'📊 Принципы работы',
  'prin.earn.title':'Где зарабатываем',
  'prin.earn.text':'В боковых движениях (консолидациях)- рынок большую часть времени находится именно здесь',
  'prin.lose.title':'Где теряем',
  'prin.lose.text':'На импульсах и переходах к новым ценовым диапазонам- это наша зона уязвимости',
  'prin.img':'Примеры отработок сигналов:',
  'rules.title':'🎯 Базовые правила',
  'rule.1':'Размер позиции: <strong>1–5%</strong> от депозита на один сигнал',
  'rule.2':'Время входа: оптимально <strong>10 минут</strong>',
  'rule.3':'Пропускайте вход, если цена ушла импульсом <strong>без откатов</strong> после сигнала',
  'rule.4':'<strong>Не заходите</strong> на один сигнал 3–4 ставками',
  'rule.5':'При получении сигнала войти по <strong>«лучшей цене»</strong> с откатом',
  'risk.title':'⚠️ Риск-менеджмент',
  'risk.1':'НЕ завышайте риски','risk.2':'НЕ входите в сделку более одного раза на ускорении',
  'risk.3':'Сохраняйте хладнокровие','risk.4':'Держитесь плана',
  'risk.5':'Убытки на импульсах- нормальная часть работы',
  'check.title':'📋 Чек-лист перед входом',
  'check.1':'Рынок в боковом движении?','check.2':'Нет сильного импульса?',
  'check.3':'Размер позиции не более 5% от депозита?',
  'check.4':'Готов принять убыток, если сигнал не сработает?','check.reset':'Сбросить',
  'psych.title':'💪 Психология торговли',
  'psych.1':'🎯 Дисциплина важнее прибыли','psych.2':'🛡️ Контроль рисков- основа успеха',
  'psych.3':'⏳ Терпение в боковых движениях окупается',
  'psych.4':'📚 Каждый убыток- цена апгрейда стратегии',
  'psych.goal':'🎯 Цель: стабильная прибыль в долгосрочной перспективе, а не быстрые деньги',
  'psych.img':'Примеры успешных серий:',
  'ulinks.title':'🔗 Полезные ссылки','ulinks.channel':'Основной канал сигналов',
  'ulinks.chat':'Чат для общения','ulinks.video':'Видео-гайд: открытие позиций',
  'ulinks.example':'Пример входа по «лучшей цене»',
  'wip.title':'В разработке',
  'wip.fs.desc':'Проводятся бектесты стратегий.<br/>Раздел будет запущен в ближайшее время.',
  'wip.fs.progress':'Бектестирование...',
  'wip.fs.1':'Торговые стратегии с описаниями','wip.fs.2':'Результаты бектестов',
  'wip.fs.3':'Условия входа и выхода','wip.fs.4':'Риск-менеджмент для каждой стратегии',
  'wip.ind.desc':'Индикаторы для TradingView<br/>скоро будут доступны здесь.',
  'wip.ind.progress':'Разработка...',
  'wip.ind.1':'Индикаторы для MEXC Futures Prediction',
  'wip.ind.2':'Инструкции по установке','wip.ind.3':'Настройка оповещений',
  'art.tag.psych':'Психология','art.tag.mind':'Мышление','art.tag.edu':'Обучение',
  'art.read':'Читать →',
  'art.tilt.title':'Ты борешься не с тильтом',
  'art.tilt.preview':'Тильт- лишь вершина. Корень- страх, который управляет твоими решениями.',
  'art.paradigm.title':'Почему дисциплина всегда побеждает эмоции',
  'art.paradigm.preview':'Стабильность приходит не из сигналов, а из системы поведения.',
  'art.whatis.title':'Futures Prediction: как это работает на самом деле',
  'art.whatis.preview':'Механика, расчёты и то, о чём обычно не говорят.',
  'art.focus.title':'Грааля не существует. Есть система',
  'art.focus.preview':'Чем сильнее ты пытаешься «победить рынок», тем хуже итог.',
  'stats.page.title':'Статистика сигналов',
  'stats.pnl':'Total PNL- ALL Periods','stats.pairs':'By Trading Pair- Last 7 Days',
  'stats.tz':'By Time Zone- Last 7 Days','stats.hour':'By Hour Zone- ALL Periods',
  'stats.indicator':'By Indicator Series- Last 7 Days','stats.open':'Открыть полную таблицу →',
  'art.tilt.full':'Тильт- не враг.<br/>Он всего лишь симптом.',
  'art.paradigm.full':'Эмоции или Дисциплина',
  'art.whatis.full':'Что такое Futures Prediction?',
  'art.focus.full':'Грааля не существует.<br/>Есть система.',
  'art.tg':'Читать в Telegram →',

  'art.tilt.body': `<p>Все привыкли: тильт- это главный враг трейдера. Сливы, эмоции, бессмысленные сделки. Но правда глубже: <strong>тильт- это не болезнь. Это симптом страха.</strong></p>
<div class="article-highlight red"><strong>🔴 Страх Потерять</strong><p>Закрываешь прибыль слишком рано. Боишься заходить в сделку. Или пересиживаешь минус, лишь бы не фиксить убыток. Потому что «страшно признать свою ошибку».</p></div>
<div class="article-highlight red"><strong>🔴 Страх Упустить</strong><p>Влетаешь без сигнала. Гонишься за движением. Покупаешь на хаях. Потому что «вдруг всё уйдёт без меня».</p></div>
<p>Эти два страха- как клещи, что сдавливают голову. Именно они ломают систему. А тильт- уже последствие.</p>
<div class="article-highlight dark"><strong>❌ Тильт начинается не со слива, а с отклонения от правил</strong><ul><li>Испугался- закрыл рано</li><li>Упустил движение- начал злиться</li><li>Захотел «исправить»- начал мстить рынку</li></ul></div>
<div class="article-highlight blue"><strong>✅ Лекарство от тильта</strong><p>Не «отходи от компьютера» и не «делай перерыв». А прямо взгляни в страх. Признай его. Научись действовать по системе, несмотря на него.</p><p>Когда страх перестаёт управлять решениями- тильт уходит сам.</p></div>`,

  'art.paradigm.body': `<p>Каждый, кто переживал глубокую просадку, задавался вопросом: <em>«Что я делаю не так?»</em></p>
<p>Меняют стратегии, индикаторы, читают аналитику… но снова тильт и выгорание. Ответ не в стратегии- а в парадигме, через которую вы смотрите на рынок.</p>
<div class="paradigm-grid"><div class="paradigm-card bad"><div class="paradigm-label">🔺 Количественный подход</div><div class="paradigm-subtitle">Путь новичка</div><div class="paradigm-thought">«Надо угадывать»</div><ul class="paradigm-list"><li>Убыток = ошибка, даже если всё сделал по правилам</li><li>Эмоции управляют решениями</li><li>После серии неудач- срыв и слив</li><li>Попытка контролировать рынок, а не себя</li></ul></div><div class="paradigm-card good"><div class="paradigm-label">🔹 Качественный подход</div><div class="paradigm-subtitle">Путь профи</div><div class="paradigm-thought">«Надо исполнять»</div><ul class="paradigm-list"><li>Хорошая сделка- та, что по правилам, даже если в минус</li><li>Убытки- часть процесса, а не провал</li><li>Главное- стабильность на дистанции</li><li>Прибыль- побочный эффект правильных действий</li></ul></div></div>
<div class="article-highlight blue"><strong>💡 Главный вывод</strong><p>Профессионал отличается от новичка не инструментами, а мышлением. Меняется не стратегия- меняешься ты.</p><p>С переходом к качественной парадигме трейдинг становится работой, а не игрой в угадайку.</p></div>`,

  'art.whatis.body': `<p>Фьючерсные прогнозы- это возможность заработать на прогнозировании цены криптовалют. Вы ставите ставку: вырастет цена или упадет за определенное время.</p>
<div class="steps-list"><div class="step-item"><div class="step-num">1</div><div class="step-content"><strong>Выберите базовый актив</strong><p>BTC или ETH на MEXC или Binance</p></div></div><div class="step-item"><div class="step-num">2</div><div class="step-content"><strong>Выберите время истечения (экспирации)</strong><p>10м, 30м, 1ч или 1д- в зависимости от ваших предпочтений</p></div></div><div class="step-item"><div class="step-num">3</div><div class="step-content"><strong>Введите сумму</strong><p>Минимум: 5 USDT · Максимум: 250 USDT на сделку</p></div></div><div class="step-item"><div class="step-num">4</div><div class="step-content"><strong>Выберите направление</strong><p><span class="dir-up">↑ Рост</span>- если ожидаете рост · <span class="dir-down">↓ Падение</span>- если ожидаете снижение</p></div></div><div class="step-item"><div class="step-num">5</div><div class="step-content"><strong>Подтвердите и ждите</strong><p>Позицию нельзя закрыть досрочно- расчёт автоматически по истечении</p></div></div></div>
<div class="content-card"><h3 class="section-title">💰 Расчёт выплат</h3><div class="formula-block"><div class="formula">Сумма расчёта = Основная сумма + Прибыль</div><div class="formula">Прибыль = Сумма × Коэффициент выплат</div></div><div class="example-block"><div class="example-title">Пример (выплата 80%, вход 10 USDT):</div><div class="example-row win">✅ Верный прогноз: получаете 18 USDT (+8 USDT)</div><div class="example-row loss">❌ Неверный прогноз: теряете 10 USDT</div><div class="example-row draw">➖ Ничья (цена не изменилась): возврат 10 USDT</div></div></div>
<div class="content-card"><h3 class="section-title">📊 Основные лимиты</h3><div class="limits-list"><div class="limit-item"><span>🚫</span> Дневные убытки: максимум 10 000 USDT</div><div class="limit-item"><span>📊</span> Открытые позиции: не более 5 одновременно</div><div class="limit-item"><span>🔢</span> Сделок в день: до 100</div><div class="limit-item"><span>🔒</span> Нельзя закрыть позицию досрочно</div><div class="limit-item"><span>🤖</span> API-торговля недоступна</div></div></div>`,

  'art.focus.body': `<p>Большинство в рынке делают одно и то же: ищут Грааль, прыгают по сетапам, поглощают тонны инфы... и годами сливают депозиты.</p>
<p>Пока не приходит неприятное осознание: <strong>проблема не в рынке. Проблема в фокусе.</strong></p>
<div class="article-highlight dark"><div class="insight-row"><div class="insight-icon insight-icon-purple"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg></div><strong>Хватит «угадывать» рынок</strong></div><p>Попытки найти идеальную точку входа- это ловушка. Рынок- это математика + психология.</p><p>Твоя задача: исполнять систему, держать матожидание. <strong>Перестаёшь гнаться за прибылью → начинаешь её получать.</strong></p></div>
<div class="article-highlight blue"><div class="insight-row"><div class="insight-icon insight-icon-blue"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg></div><strong>24/7 у монитора = выгорание</strong></div><p>Чем больше смотришь- тем хуже решения. Рабочий алгоритм: <strong>Утро (анализ) → Сценарии → Алерты.</strong> Рынок сам приходит к тебе.</p></div>
<div class="article-highlight dark"><div class="insight-row"><div class="insight-icon insight-icon-purple"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg></div><strong>Дисциплина и состояние</strong></div><p>Слабое состояние = плохие сделки. Если эмоции берут верх- ставь лимиты потерь. Система не даст слить больше нормы.</p></div>
<div class="article-highlight blue"><div class="insight-row"><div class="insight-icon insight-icon-blue"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg></div><strong>Оцифруй свою реальность</strong></div><p>Нет дневника- нет роста. Дневник + бэктесты = твоя объективная реальность. Пропустил разбор ошибок- потерял форму.</p></div>
<div class="article-highlight red"><div class="insight-row"><div class="insight-icon insight-icon-red"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg></div><strong>Главный инсайт</strong></div><p><strong>Меньше действий → больше денег.</strong> Больше сделок = больше шума. Рынок платит не за умные мысли- <strong>рынок платит за дисциплину.</strong></p></div>`,
},

// ==================== ENGLISH ====================
en: {
  'nav.home':'Home','nav.signals':'Signals','nav.stats':'Statistics','nav.articles':'Articles',
  'home.sub':'Trading Signals · Strategies · Education',
  'menu.fp.sub':'Signals · Rules · Entry Strategy',
  'menu.fs.title':'Futures Strategy','menu.fs.sub':'Trading Strategies · Backtests',
  'menu.ind.title':'Indicators','menu.ind.sub':'TradingView Indicators',
  'menu.art.title':'Articles','menu.art.sub':'Psychology · Education',
  'stats.label':'Signal Statistics','stats.more':'More ›',
  'stats.wr7d':'WinRate Last 7 Day','stats.sig7d':'Signals Last 7 Day',
  'stats.wrall':'WinRate Total','stats.sigall':'Signals Total',
  'link.main':'Main Channel','link.chat':'Community Chat','btn.refresh':'Refresh',
  'title.fp':'Futures Prediction','title.fs':'Futures Strategy',
  'title.ind':'Indicators','title.art':'Articles','title.stats':'Statistics',
  'title.stats.l30d':'Last 30 Days','title.stats.all':'ALL Periods',
  'sig.today':'Today\'s Signals','sig.group.btn':'Signals Group',
  'sig.empty':'No signals today','sig.loading':'Loading...','sig.error':'Load error',
  'sig.sum.total':'Total','sig.ago.h':'h','sig.ago.m':'m','sig.ago.s':'s','sig.ago.word':'ago',
  'warn.title':'🔴 Important Warning',
  'warn.text':'The strategy <strong>does NOT work</strong> in strong trends and impulses without pullbacks!',
  'warn.1':'Price moves impulsively without pullbacks',
  'warn.2':'Strong no-pullback moves are occurring',
  'warn.3':'Market is in an active trend',
  'prin.title':'📊 How It Works',
  'prin.earn.title':'Where we profit',
  'prin.earn.text':'In sideways movements (consolidations)- the market spends most of its time here',
  'prin.lose.title':'Where we lose',
  'prin.lose.text':'On impulses and transitions to new price ranges- this is our vulnerability zone',
  'prin.img':'Signal execution examples:',
  'rules.title':'🎯 Basic Rules',
  'rule.1':'Position size: <strong>1–5%</strong> of deposit per signal',
  'rule.2':'Entry time: optimally <strong>10 minutes</strong>',
  'rule.3':'Skip entry if price moved impulsively <strong>without pullbacks</strong> after the signal',
  'rule.4':'<strong>Do not enter</strong> one signal with 3–4 bets',
  'rule.5':'On signal, enter at the <strong>"best price"</strong> with a pullback',
  'risk.title':'⚠️ Risk Management',
  'risk.1':'Do NOT oversize risks','risk.2':'Do NOT enter a trade more than once on acceleration',
  'risk.3':'Stay calm','risk.4':'Stick to the plan',
  'risk.5':'Losses on impulses are a normal part of the work',
  'check.title':'📋 Pre-Entry Checklist',
  'check.1':'Is the market in sideways movement?','check.2':'No strong impulse?',
  'check.3':'Position size no more than 5% of deposit?',
  'check.4':'Ready to accept a loss if the signal fails?','check.reset':'Reset',
  'psych.title':'💪 Trading Psychology',
  'psych.1':'🎯 Discipline over profit','psych.2':'🛡️ Risk control is the foundation',
  'psych.3':'⏳ Patience in sideways markets pays off',
  'psych.4':'📚 Every loss is the price of upgrading your strategy',
  'psych.goal':'🎯 Goal: consistent long-term profit, not quick money',
  'psych.img':'Successful streak examples:',
  'ulinks.title':'🔗 Useful Links','ulinks.channel':'Main signals channel',
  'ulinks.chat':'Community chat','ulinks.video':'Video guide: opening positions',
  'ulinks.example':'Best price entry example',
  'wip.title':'In Development',
  'wip.fs.desc':'Strategy backtests are in progress.<br/>Section launches soon.',
  'wip.fs.progress':'Backtesting...','wip.fs.1':'Trading strategies with descriptions',
  'wip.fs.2':'Backtest results','wip.fs.3':'Entry and exit conditions',
  'wip.fs.4':'Risk management for each strategy',
  'wip.ind.desc':'TradingView indicators<br/>coming here soon.',
  'wip.ind.progress':'Development...','wip.ind.1':'Indicators for MEXC Futures Prediction',
  'wip.ind.2':'Installation instructions','wip.ind.3':'Alert setup',
  'art.tag.psych':'Psychology','art.tag.mind':'Mindset','art.tag.edu':'Education',
  'art.read':'Read →',
  'art.tilt.title':'You\'re not fighting tilt',
  'art.tilt.preview':'Tilt is just the surface. The root is fear controlling your decisions.',
  'art.paradigm.title':'Why discipline always beats emotions',
  'art.paradigm.preview':'Consistency comes not from signals, but from a system of behavior.',
  'art.whatis.title':'Futures Prediction: how it actually works',
  'art.whatis.preview':'Mechanics, calculations, and what\'s usually left unsaid.',
  'art.focus.title':'There is no Holy Grail. There is a system',
  'art.focus.preview':'The harder you try to "beat the market", the worse the outcome.',
  'stats.page.title':'Signal Statistics',
  'stats.pnl':'Total PNL- ALL Periods','stats.pairs':'By Trading Pair- Last 7 Days',
  'stats.tz':'By Time Zone- Last 7 Days','stats.hour':'By Hour Zone- ALL Periods',
  'stats.indicator':'By Indicator Series- Last 7 Days','stats.open':'Open full table →',
  'art.tilt.full':'Tilt is not your enemy.<br/>It\'s just a symptom.',
  'art.paradigm.full':'Emotions or Discipline',
  'art.whatis.full':'What is Futures Prediction?',
  'art.focus.full':'There is no Holy Grail.<br/>There is a system.',
  'art.tg':'Read on Telegram →',

  'art.tilt.body': `<p>Everyone says it: tilt is a trader's worst enemy. Losses, emotions, pointless trades. But the truth goes deeper: <strong>tilt is not a disease. It's a symptom of fear.</strong></p>
<div class="article-highlight red"><strong>🔴 Fear of Losing</strong><p>You close profits too early. You're afraid to enter trades. Or you hold a losing position to avoid admitting the mistake. Because "being wrong is scary".</p></div>
<div class="article-highlight red"><strong>🔴 Fear of Missing Out</strong><p>You jump in without a signal. You chase price moves. You buy at the top. Because "what if it all goes without me".</p></div>
<p>These two fears grip your mind like a vice. They break your system. And tilt is just the consequence.</p>
<div class="article-highlight dark"><strong>❌ Tilt starts not with a loss, but with breaking the rules</strong><ul><li>Got scared- closed too early</li><li>Missed a move- started getting angry</li><li>Wanted to "fix it"- started revenge trading</li></ul></div>
<div class="article-highlight blue"><strong>✅ The cure for tilt</strong><p>Not "step away from the computer" or "take a break". Instead, look fear directly in the eye. Acknowledge it. Learn to act on your system despite it.</p><p>When fear stops controlling your decisions- tilt disappears on its own.</p></div>`,

  'art.paradigm.body': `<p>Everyone who has experienced a deep drawdown has asked themselves: <em>"What am I doing wrong?"</em></p>
<p>They switch strategies, indicators, consume analytics… but tilt and burnout return. The answer isn't in the strategy- it's in the paradigm through which you view the market.</p>
<div class="paradigm-grid"><div class="paradigm-card bad"><div class="paradigm-label">🔺 Quantitative approach</div><div class="paradigm-subtitle">The beginner's path</div><div class="paradigm-thought">"Need to guess"</div><ul class="paradigm-list"><li>A loss = a mistake, even if you followed the rules</li><li>Emotions drive decisions</li><li>After a losing streak- breakdown and blowup</li><li>Trying to control the market, not yourself</li></ul></div><div class="paradigm-card good"><div class="paradigm-label">🔹 Qualitative approach</div><div class="paradigm-subtitle">The professional's path</div><div class="paradigm-thought">"Need to execute"</div><ul class="paradigm-list"><li>A good trade follows the rules, even if it's a loss</li><li>Losses are part of the process, not a failure</li><li>Consistency over the long run is key</li><li>Profit is a side effect of correct actions</li></ul></div></div>
<div class="article-highlight blue"><strong>💡 The main takeaway</strong><p>A professional differs from a beginner not in tools, but in mindset. It's not the strategy that changes- it's you.</p><p>When you shift to the qualitative paradigm, trading becomes work, not a guessing game.</p></div>`,

  'art.whatis.body': `<p>Futures Prediction is an opportunity to profit by predicting cryptocurrency prices. You place a bet: will the price go up or down within a set time period.</p>
<div class="steps-list"><div class="step-item"><div class="step-num">1</div><div class="step-content"><strong>Choose the base asset</strong><p>BTC or ETH on MEXC or Binance</p></div></div><div class="step-item"><div class="step-num">2</div><div class="step-content"><strong>Choose expiration time</strong><p>10m, 30m, 1h or 1d- depending on your preference</p></div></div><div class="step-item"><div class="step-num">3</div><div class="step-content"><strong>Enter the amount</strong><p>Minimum: 5 USDT · Maximum: 250 USDT per trade</p></div></div><div class="step-item"><div class="step-num">4</div><div class="step-content"><strong>Choose the direction</strong><p><span class="dir-up">↑ Up</span>- if you expect growth · <span class="dir-down">↓ Down</span>- if you expect a decline</p></div></div><div class="step-item"><div class="step-num">5</div><div class="step-content"><strong>Confirm and wait</strong><p>Positions cannot be closed early- settlement is automatic at expiration</p></div></div></div>
<div class="content-card"><h3 class="section-title">💰 Payout Calculation</h3><div class="formula-block"><div class="formula">Settlement = Principal + Profit</div><div class="formula">Profit = Amount × Payout Coefficient</div></div><div class="example-block"><div class="example-title">Example (80% payout, 10 USDT entry):</div><div class="example-row win">✅ Correct prediction: receive 18 USDT (+8 USDT)</div><div class="example-row loss">❌ Wrong prediction: lose 10 USDT</div><div class="example-row draw">➖ Draw (price unchanged): 10 USDT returned</div></div></div>
<div class="content-card"><h3 class="section-title">📊 Key Limits</h3><div class="limits-list"><div class="limit-item"><span>🚫</span> Daily losses: max 10,000 USDT</div><div class="limit-item"><span>📊</span> Open positions: max 5 simultaneously</div><div class="limit-item"><span>🔢</span> Trades per day: up to 100</div><div class="limit-item"><span>🔒</span> Positions cannot be closed early</div><div class="limit-item"><span>🤖</span> API trading not available</div></div></div>`,

  'art.focus.body': `<p>Most people in the market do the same thing: search for the Holy Grail, jump between setups, consume information... and blow their accounts for years.</p>
<p>Until the uncomfortable realization hits: <strong>the problem isn't the market. The problem is focus.</strong></p>
<div class="article-highlight dark"><div class="insight-row"><div class="insight-icon insight-icon-purple"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg></div><strong>Stop trying to "guess" the market</strong></div><p>Searching for the perfect entry is a trap. The market is math + psychology.</p><p>Your job: execute the system, maintain positive expectancy. <strong>Stop chasing profit → start receiving it.</strong></p></div>
<div class="article-highlight blue"><div class="insight-row"><div class="insight-icon insight-icon-blue"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg></div><strong>24/7 at the screen = burnout</strong></div><p>More screen time = worse decisions. The workflow: <strong>Morning (analysis) → Scenarios → Alerts.</strong> Then the market comes to you.</p></div>
<div class="article-highlight dark"><div class="insight-row"><div class="insight-icon insight-icon-purple"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg></div><strong>Discipline and mental state</strong></div><p>Poor state = poor trades. If emotions take over- set loss limits via software. The system won't let you blow more than your limit.</p></div>
<div class="article-highlight blue"><div class="insight-row"><div class="insight-icon insight-icon-blue"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg></div><strong>Quantify your reality</strong></div><p>No journal = no growth. Journal + backtests = your objective reality. Skip your weekly error review and you immediately lose your edge.</p></div>
<div class="article-highlight red"><div class="insight-row"><div class="insight-icon insight-icon-red"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg></div><strong>The key insight</strong></div><p><strong>Fewer actions → more money.</strong> More trades = more noise. The market doesn't pay for smart thinking- <strong>it pays for discipline.</strong></p></div>`,
},

// ==================== UKRAINIAN ====================
uk: {
  'nav.home':'Головна','nav.signals':'Сигнали','nav.stats':'Статистика','nav.articles':'Статті',
  'home.sub':'Торгові сигнали · Стратегії · Навчання',
  'menu.fp.sub':'Сигнали · Правила · Стратегія входу',
  'menu.fs.title':'Futures Strategy','menu.fs.sub':'Торгові стратегії · Бектести',
  'menu.ind.title':'Індикатори','menu.ind.sub':'Індикатори TradingView',
  'menu.art.title':'Статті','menu.art.sub':'Психологія · Навчання',
  'stats.label':'Статистика сигналів','stats.more':'Детальніше ›',
  'stats.wr7d':'WinRate Last 7 Day','stats.sig7d':'Signals Last 7 Day',
  'stats.wrall':'WinRate Total','stats.sigall':'Signals Total',
  'link.main':'Основний канал','link.chat':'Чат спільноти','btn.refresh':'Оновити',
  'title.fp':'Futures Prediction','title.fs':'Futures Strategy',
  'title.ind':'Індикатори','title.art':'Статті','title.stats':'Статистика',
  'title.stats.l30d':'Last 30 Days','title.stats.all':'ALL Periods',
  'sig.today':'Сигнали сьогодні','sig.group.btn':'Signals Group',
  'sig.empty':'Сигналів сьогодні немає','sig.loading':'Завантаження...','sig.error':'Помилка завантаження',
  'sig.sum.total':'Всього','sig.ago.h':'г','sig.ago.m':'хв','sig.ago.s':'с','sig.ago.word':'тому',
  'warn.title':'🔴 Важливе попередження',
  'warn.text':'Стратегія <strong>НЕ працює</strong> на сильних трендах та імпульсах без відкатів!',
  'warn.1':'Ціна рухається імпульсно без відкатів',
  'warn.2':'Відбуваються сильні безвідкатні рухи',
  'warn.3':'Ринок знаходиться в активному тренді',
  'prin.title':'📊 Принципи роботи',
  'prin.earn.title':'Де заробляємо',
  'prin.earn.text':'У бокових рухах (консолідаціях)- ринок більшу частину часу знаходиться саме тут',
  'prin.lose.title':'Де втрачаємо',
  'prin.lose.text':'На імпульсах та переходах до нових цінових діапазонів- це наша зона вразливості',
  'prin.img':'Приклади відпрацювань сигналів:',
  'rules.title':'🎯 Базові правила',
  'rule.1':'Розмір позиції: <strong>1–5%</strong> від депозиту на один сигнал',
  'rule.2':'Час входу: оптимально <strong>10 хвилин</strong>',
  'rule.3':'Пропускайте вхід, якщо ціна пішла імпульсом <strong>без відкатів</strong> після сигналу',
  'rule.4':'<strong>Не заходьте</strong> на один сигнал 3–4 ставками',
  'rule.5':'При отриманні сигналу увійти по <strong>«кращій ціні»</strong> з відкатом',
  'risk.title':'⚠️ Ризик-менеджмент',
  'risk.1':'НЕ завищуйте ризики','risk.2':'НЕ входьте в угоду більше одного разу на прискоренні',
  'risk.3':'Зберігайте холоднокровність','risk.4':'Тримайтеся плану',
  'risk.5':'Збитки на імпульсах- нормальна частина роботи',
  'check.title':'📋 Чек-лист перед входом',
  'check.1':'Ринок у боковому русі?','check.2':'Немає сильного імпульсу?',
  'check.3':'Розмір позиції не більше 5% від депозиту?',
  'check.4':'Готовий прийняти збиток, якщо сигнал не спрацює?','check.reset':'Скинути',
  'psych.title':'💪 Психологія торгівлі',
  'psych.1':'🎯 Дисципліна важливіша за прибуток','psych.2':'🛡️ Контроль ризиків- основа успіху',
  'psych.3':'⏳ Терпіння в бокових рухах окупається',
  'psych.4':'📚 Кожен збиток- ціна апгрейду стратегії',
  'psych.goal':'🎯 Мета: стабільний прибуток у довгостроковій перспективі, а не швидкі гроші',
  'psych.img':'Приклади успішних серій:',
  'ulinks.title':'🔗 Корисні посилання','ulinks.channel':'Основний канал сигналів',
  'ulinks.chat':'Чат для спілкування','ulinks.video':'Відео-гайд: відкриття позицій',
  'ulinks.example':'Приклад входу по «кращій ціні»',
  'wip.title':'У розробці',
  'wip.fs.desc':'Проводяться бектести стратегій.<br/>Розділ буде запущено найближчим часом.',
  'wip.fs.progress':'Бектестування...','wip.fs.1':'Торгові стратегії з описами',
  'wip.fs.2':'Результати бектестів','wip.fs.3':'Умови входу та виходу',
  'wip.fs.4':'Ризик-менеджмент для кожної стратегії',
  'wip.ind.desc':'Індикатори для TradingView<br/>незабаром будуть доступні тут.',
  'wip.ind.progress':'Розробка...','wip.ind.1':'Індикатори для MEXC Futures Prediction',
  'wip.ind.2':'Інструкції з встановлення','wip.ind.3':'Налаштування сповіщень',
  'art.tag.psych':'Психологія','art.tag.mind':'Мислення','art.tag.edu':'Навчання',
  'art.read':'Читати →',
  'art.tilt.title':'Ти б\'єшся не з тільтом',
  'art.tilt.preview':'Тільт- лише вершина. Корінь- страх, який керує твоїми рішеннями.',
  'art.paradigm.title':'Чому дисципліна завжди перемагає емоції',
  'art.paradigm.preview':'Стабільність приходить не із сигналів, а із системи поведінки.',
  'art.whatis.title':'Futures Prediction: як це насправді працює',
  'art.whatis.preview':'Механіка, розрахунки і те, про що зазвичай не говорять.',
  'art.focus.title':'Грааля не існує. Є система',
  'art.focus.preview':'Чим сильніше ти намагаєшся «перемогти ринок», тим гірший результат.',
  'stats.page.title':'Статистика сигналів',
  'stats.pnl':'Total PNL- ALL Periods','stats.pairs':'By Trading Pair- Last 7 Days',
  'stats.tz':'By Time Zone- Last 7 Days','stats.hour':'By Hour Zone- ALL Periods',
  'stats.indicator':'By Indicator Series- Last 7 Days','stats.open':'Відкрити повну таблицю →',
  'art.tilt.full':'Тільт- не ворог.<br/>Він лише симптом.',
  'art.paradigm.full':'Емоції чи Дисципліна',
  'art.whatis.full':'Що таке Futures Prediction?',
  'art.focus.full':'Грааля не існує.<br/>Є система.',
  'art.tg':'Читати в Telegram →',

  'art.tilt.body': `<p>Всі звикли: тільт- це головний ворог трейдера. Зливи, емоції, безглузді угоди. Але правда глибша: <strong>тільт- це не хвороба. Це симптом страху.</strong></p>
<div class="article-highlight red"><strong>🔴 Страх Втратити</strong><p>Закриваєш прибуток надто рано. Боїшся входити в угоду. Або пересиджуєш мінус, аби не фіксити збиток. Бо «страшно визнати свою помилку».</p></div>
<div class="article-highlight red"><strong>🔴 Страх Пропустити</strong><p>Влітаєш без сигналу. Женешся за рухом. Купуєш на хаях. Бо «раптом все піде без мене».</p></div>
<p>Ці два страхи- як лещата, що стискають голову. Саме вони ламають систему. А тільт- уже наслідок.</p>
<div class="article-highlight dark"><strong>❌ Тільт починається не зі зливу, а з відхилення від правил</strong><ul><li>Злякався- закрив рано</li><li>Пропустив рух- почав злитися</li><li>Захотів «виправити»- почав мститися ринку</li></ul></div>
<div class="article-highlight blue"><strong>✅ Ліки від тільту</strong><p>Не «відходь від комп'ютера» і не «роби перерву». А прямо подивися у страх. Визнай його. Навчися діяти за системою, попри нього.</p><p>Коли страх перестає керувати рішеннями- тільт іде сам.</p></div>`,

  'art.paradigm.body': `<p>Кожен, хто переживав глибоку просадку, ставив собі запитання: <em>«Що я роблю не так?»</em></p>
<p>Міняють стратегії, індикатори, читають аналітику… але знову тільт і вигорання. Відповідь не в стратегії- а в парадигмі, через яку ти дивишся на ринок.</p>
<div class="paradigm-grid"><div class="paradigm-card bad"><div class="paradigm-label">🔺 Кількісний підхід</div><div class="paradigm-subtitle">Шлях новачка</div><div class="paradigm-thought">«Треба вгадувати»</div><ul class="paradigm-list"><li>Збиток = помилка, навіть якщо зробив все за правилами</li><li>Емоції керують рішеннями</li><li>Після серії невдач- зрив і злив</li><li>Спроба контролювати ринок, а не себе</li></ul></div><div class="paradigm-card good"><div class="paradigm-label">🔹 Якісний підхід</div><div class="paradigm-subtitle">Шлях профі</div><div class="paradigm-thought">«Треба виконувати»</div><ul class="paradigm-list"><li>Хороша угода- та, що за правилами, навіть якщо в мінус</li><li>Збитки- частина процесу, а не провал</li><li>Головне- стабільність на дистанції</li><li>Прибуток- побічний ефект правильних дій</li></ul></div></div>
<div class="article-highlight blue"><strong>💡 Головний висновок</strong><p>Професіонал відрізняється від новачка не інструментами, а мисленням. Змінюється не стратегія- змінюєшся ти.</p><p>З переходом до якісної парадигми трейдинг стає роботою, а не грою в угадайку.</p></div>`,

  'art.whatis.body': `<p>Ф'ючерсні прогнози- це можливість заробити на прогнозуванні ціни криптовалют. Ти ставиш ставку: зросте ціна чи впаде за певний час.</p>
<div class="steps-list"><div class="step-item"><div class="step-num">1</div><div class="step-content"><strong>Обери базовий актив</strong><p>BTC або ETH на MEXC або Binance</p></div></div><div class="step-item"><div class="step-num">2</div><div class="step-content"><strong>Обери час експірації</strong><p>10хв, 30хв, 1год або 1д- залежно від твоїх вподобань</p></div></div><div class="step-item"><div class="step-num">3</div><div class="step-content"><strong>Введи суму</strong><p>Мінімум: 5 USDT · Максимум: 250 USDT на угоду</p></div></div><div class="step-item"><div class="step-num">4</div><div class="step-content"><strong>Обери напрямок</strong><p><span class="dir-up">↑ Зріст</span>- якщо очікуєш зріст · <span class="dir-down">↓ Падіння</span>- якщо очікуєш зниження</p></div></div><div class="step-item"><div class="step-num">5</div><div class="step-content"><strong>Підтверди і чекай</strong><p>Позицію не можна закрити достроково- розрахунок відбувається автоматично після закінчення</p></div></div></div>
<div class="content-card"><h3 class="section-title">💰 Розрахунок виплат</h3><div class="formula-block"><div class="formula">Сума розрахунку = Основна сума + Прибуток</div><div class="formula">Прибуток = Сума × Коефіцієнт виплат</div></div><div class="example-block"><div class="example-title">Приклад (виплата 80%, вхід 10 USDT):</div><div class="example-row win">✅ Правильний прогноз: отримуєш 18 USDT (+8 USDT)</div><div class="example-row loss">❌ Неправильний прогноз: втрачаєш 10 USDT</div><div class="example-row draw">➖ Нічия (ціна не змінилась): повернення 10 USDT</div></div></div>
<div class="content-card"><h3 class="section-title">📊 Основні ліміти</h3><div class="limits-list"><div class="limit-item"><span>🚫</span> Денні збитки: максимум 10 000 USDT</div><div class="limit-item"><span>📊</span> Відкриті позиції: не більше 5 одночасно</div><div class="limit-item"><span>🔢</span> Угод на день: до 100</div><div class="limit-item"><span>🔒</span> Не можна закрити позицію достроково</div><div class="limit-item"><span>🤖</span> API-торгівля недоступна</div></div></div>`,

  'art.focus.body': `<p>Більшість на ринку роблять одне й те саме: шукають Грааль, стрибають по сетапах, поглинають тонни інфи... і роками зливають депозити.</p>
<p>Поки не приходить неприємне усвідомлення: <strong>проблема не в ринку. Проблема у фокусі.</strong></p>
<div class="article-highlight dark"><div class="insight-row"><div class="insight-icon insight-icon-purple"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg></div><strong>Годі «вгадувати» ринок</strong></div><p>Пошук ідеальної точки входу- це пастка. Ринок- це математика + психологія.</p><p>Твоє завдання: виконувати систему, тримати математичне очікування. <strong>Перестаєш гнатися за прибутком → починаєш його отримувати.</strong></p></div>
<div class="article-highlight blue"><div class="insight-row"><div class="insight-icon insight-icon-blue"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg></div><strong>24/7 біля монітора = вигорання</strong></div><p>Більше дивишся- гірші рішення. Робочий алгоритм: <strong>Ранок (аналіз) → Сценарії → Алерти.</strong> Ринок сам приходить до тебе.</p></div>
<div class="article-highlight dark"><div class="insight-row"><div class="insight-icon insight-icon-purple"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg></div><strong>Дисципліна і стан</strong></div><p>Поганий стан = погані угоди. Якщо емоції беруть верх- став ліміти збитків. Система не дасть злити більше норми.</p></div>
<div class="article-highlight blue"><div class="insight-row"><div class="insight-icon insight-icon-blue"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg></div><strong>Оцифруй свою реальність</strong></div><p>Немає щоденника- немає зростання. Щоденник + бектести = твоя об'єктивна реальність. Пропустив розбір помилок- втратив форму.</p></div>
<div class="article-highlight red"><div class="insight-row"><div class="insight-icon insight-icon-red"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg></div><strong>Головний інсайт</strong></div><p><strong>Менше дій → більше грошей.</strong> Більше угод = більше шуму. Ринок платить не за розумні думки- <strong>ринок платить за дисципліну.</strong></p></div>`,
},

}; // end i18n
