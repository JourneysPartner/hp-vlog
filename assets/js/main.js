/* ============================================================
   毛利順活税理士事務所 — main.js
   ============================================================ */

document.addEventListener('DOMContentLoaded', () => {

  // ── 1. Sticky Header scroll effect ──
  const header = document.getElementById('header');
  const onScroll = () => {
    if (window.scrollY > 50) {
      header.classList.add('scrolled');
    } else {
      header.classList.remove('scrolled');
    }
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll(); // 初期状態

  // ── 2. Active nav link ──
  const currentPath = location.pathname;
  document.querySelectorAll('#header .nav-link').forEach(link => {
    const href = link.getAttribute('href');
    if (!href) return;
    // 完全一致（/, /about.html 等）
    if (href === currentPath) {
      link.classList.add('active');
    }
    // トップページ: /index.html → / にもマッチ
    else if (href === '/' && (currentPath === '/index.html' || currentPath === '')) {
      link.classList.add('active');
    }
    // ブログ: /blog/ 以下のパスは /blog/ リンクをアクティブにする
    else if (href === '/blog/' && currentPath.startsWith('/blog')) {
      link.classList.add('active');
    }
    // 取扱業務: /services/… と /pricing/ は「取扱業務」をアクティブにする
    else if (href === '/services.html' && (currentPath.startsWith('/services/') || currentPath.startsWith('/pricing'))) {
      link.classList.add('active');
    }
  });

  // ── 3. （スクロールアニメーションは 2026-09-03 に廃止。JS 無しでも全文が見える状態を優先）──

  // ── 4. Counter Animation ──
  const counters = document.querySelectorAll('[data-count]');
  if (counters.length > 0) {
    const animateCounter = (el) => {
      const target = parseInt(el.getAttribute('data-count'), 10);
      const duration = 1800;
      const start = performance.now();
      const update = (now) => {
        const elapsed = now - start;
        const progress = Math.min(elapsed / duration, 1);
        // ease-out cubic
        const eased = 1 - Math.pow(1 - progress, 3);
        el.textContent = Math.floor(eased * target).toLocaleString();
        if (progress < 1) requestAnimationFrame(update);
        else el.textContent = target.toLocaleString();
      };
      requestAnimationFrame(update);
    };

    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting && !entry.target.dataset.counted) {
          entry.target.dataset.counted = 'true';
          animateCounter(entry.target);
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.5 });

    counters.forEach(c => observer.observe(c));
  }

  // ── 5. Mobile nav: close on link click ──
  const navbarCollapse = document.getElementById('navbarNav');
  if (navbarCollapse) {
    navbarCollapse.querySelectorAll('.nav-link').forEach(link => {
      link.addEventListener('click', () => {
        const bsCollapse = bootstrap.Collapse.getInstance(navbarCollapse);
        if (bsCollapse) bsCollapse.hide();
      });
    });
  }

  // ── 6. Form: honeypot guard (client-side hint only) ──
  const form = document.querySelector('form[data-netlify]');
  if (form) {
    form.addEventListener('submit', (e) => {
      const honey = form.querySelector('[name="bot-field"]');
      if (honey && honey.value) { e.preventDefault(); }
    });
  }

  // ── 7. Blog pills: 「もっと見る」トグルでカテゴリ pill を展開 ──
  document.querySelectorAll('.blog-pills-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const targetId = btn.getAttribute('aria-controls');
      const extra = targetId && document.getElementById(targetId);
      if (!extra) return;
      const expanded = btn.getAttribute('aria-expanded') === 'true';
      const next = !expanded;
      btn.setAttribute('aria-expanded', String(next));
      if (next) {
        extra.removeAttribute('hidden');
        const lbl = btn.querySelector('.blog-pills-toggle-label');
        if (lbl) lbl.textContent = btn.getAttribute('data-label-close') || '閉じる';
      } else {
        extra.setAttribute('hidden', '');
        const lbl = btn.querySelector('.blog-pills-toggle-label');
        if (lbl) lbl.textContent = btn.getAttribute('data-label-open') || 'もっと見る';
      }
    });
  });

  // 現在ページがカテゴリページなら最初から展開しておく（active pill を見えるように）
  const activeCatPill = document.querySelector('.blog-pill--cat.is-active');
  if (activeCatPill) {
    const toggle = document.querySelector('.blog-pills-toggle');
    if (toggle && toggle.getAttribute('aria-expanded') !== 'true') {
      toggle.click();
    }
  }

});
