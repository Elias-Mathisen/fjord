// Fjord's website: the illustrations revealing as you reach them, the redirect link that shortens itself, and the dawn footer
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
gsap.registerPlugin(ScrollTrigger);
document.fonts.ready.then(() => ScrollTrigger.refresh());

// Smooth scrolling for the page's own links. Not CSS scroll-behavior, which throws off ScrollTrigger's measuring
document.addEventListener("click", e => {
  const link = e.target.closest('a[href^="#"]');
  const target = link && document.querySelector(link.getAttribute("href"));
  if (!target) return;
  e.preventDefault();
  target.scrollIntoView({ behavior: reduce ? "auto" : "smooth" });
  history.pushState(null, "", link.getAttribute("href"));
});

// The nav is clear over the hero and solid after it
const nav = document.querySelector(".nav");
new IntersectionObserver(([e]) => nav.classList.toggle("solid", !e.isIntersecting), { rootMargin: "-64px 0px 0px 0px" })
  .observe(document.querySelector(".hero"));

// ---------- Smaller moments ----------
if (!reduce) {
  // Each illustration opens from the bottom up as it comes into view, once
  // (on the image itself: a clip on the figure would isolate it, and the paper would stop blending into the page)
  for (const art of document.querySelectorAll(".art")) {
    gsap.from(art.querySelector("img"), {
      clipPath: "inset(100% 0 0 0)", scale: 1.08, duration: 1.2, ease: "expo.out", clearProps: "clipPath,transform",
      scrollTrigger: { trigger: art, start: "top 85%" },
    });
  }
  // The tracking redirect folds down to the real address once it's on screen
  gsap.fromTo("[data-redirect] .cut", { maxWidth: el => el.scrollWidth }, {
    maxWidth: 0, opacity: 0, duration: 1.1, delay: 0.3, ease: "power3.inOut",
    scrollTrigger: { trigger: "[data-redirect]", start: "top 75%" },
  });
  // The dawn ridges settle into place, the far ones moving most
  gsap.timeline({ scrollTrigger: { trigger: ".dawn", start: "top bottom", end: "bottom bottom", scrub: 0.5 } })
    .from(".dawn .far", { y: 60, ease: "none" }, 0)
    .from(".dawn .mid", { y: 30, ease: "none" }, 0);
}

