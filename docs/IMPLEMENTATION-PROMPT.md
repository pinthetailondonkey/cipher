You are working in `pinthetailondonkey/cipher`. Rebuild the existing UI toward the supplied Direction A mockups: a polished, premium-feeling messaging and commerce app that feels at home on mobile—not a generic dashboard or a basic dark-mode reskin.

## Product direction

- Make Threads the home for Chats, Groups, and Menus, with You as the other primary destination.
- Bring vendor menus into the vendor conversation and make order cards feel like part of the message stream.
- Make the interface feel crafted and premium through strong typography, deliberate spacing, real product imagery, subtle surface depth, and refined interaction details.
- Keep the existing app architecture and responsive web/PWA behavior; do not introduce a native-app framework as part of this work.
- Remove **“Track your order” / “Track package”** as an action, label, and separate destination. Order progress should be visible in the conversation itself. Keep the three-dot status tracker as passive, factual status. Do not lose useful order or payment information in the process.
- Avoid emoji in user-facing copy and UI. Use real listing imagery and consistent icons instead.

## Start with an audit

Before editing, inspect the current repository and relevant files. Read `docs/design-system.md` and `VOICE.md` if present; check the current status of the components and lanes described below rather than assuming the audit is still accurate. Identify existing tests, scripts, design tokens, and unfinished work. Summarize the implementation sequence and any blocked dependencies before making changes.

Preserve the engineering key `explore` wherever it is load-bearing for deep links, CommandPalette, boot behavior, or tests. Change labels and composition, not stable keys.

## Visual and interaction quality bar

The result should feel premium because of its craft, not because every surface has a glow or gradient:

- Use a restrained surface system: near-black canvas, a small number of charcoal/elevated surfaces, subtle separators, and consistent corner radii.
- Use the blue accent for primary actions; reserve green, amber, red, and gray for meaningful states as specified by the design system.
- Give product imagery room to lead. Use consistent image aspect ratios and crops; provide polished loading and missing-image treatments.
- Establish clear type hierarchy for titles, item names, prices, metadata, and status. Keep secondary copy quiet and readable.
- Avoid excessive borders, neon glows, decorative gradients, crowded cards, and emoji-like placeholder art.
- Make controls feel responsive: precise pressed/selected states, smooth but restrained transitions, and appropriate feedback when state changes.
- Respect safe areas, keyboard behavior, reduced-motion preferences, touch target sizes, scrolling, and sheet dismissal. Keep desktop layouts intentional too.
- Use accessible semantic controls, visible focus states, and appropriate labels. Do not rely on color alone to communicate status.

## Implementation plan

Work incrementally, with clear scope and tests for each lane. Do not make unrelated refactors.

1. **Foundation:** Establish or update `docs/design-system.md` as the source of truth for tokens, surfaces, typography, spacing, status colors, and component guidance. Add navigation regression tests before changing navigation where practical.
2. **Reusable segmented control:** Build an accessible, tested segmented control suitable for Threads filters and payment-method selection.
3. **Navigation and Threads:** Reduce primary navigation to Threads and You. Add Chats / Groups / Menus segments in Threads. Preserve stable keys and deep-link behavior. Migrate Orders entry points into the You tab and chat/order previews. Update first-run behavior and navigation tests.
4. **Vendor menu strip:** Add a compact, horizontal product strip to vendor conversations, backed by existing menu/listing data. Hide it when there is no menu. Coordinate with the checkout owner before changing checkout integration; do not modify `OneTapCheckout` or claimed checkout surfaces without an explicit handoff or sign-off.
5. **Inline order card:** Render order cards in the thread with product details and the three-dot Paid / Shipped / Received tracker. Derive status from order facts, not messages or a peer’s claim. Use at most one contextual primary action per state—for example Pay, Mark received, or Leave review. **There must be no Track / Track package / Track your order action or separate tracking destination.** Keep status and relevant order details visible in the conversation. Preserve the existing dispute-reason chips and payment-block behavior.
6. **Payment watcher:** If this lane is authorized and its checkout dependencies are cleared, reuse the existing payment-state logic and trust copy. Keep payment confirmation distinct from shipping progress. Do not change checkout-owned surfaces without the required handoff.
7. **Menus discovery:** Restyle discovery as a polished, photo-forward two-column grid with clear open/closed status and a menu detail sheet with a Message action.
8. **You tab:** Build a profile card, code actions, orders-in-progress entry point, and settings list. Preserve Wallet deep links and existing functionality.
9. **Polish:** Complete empty states, chat previews, loading/error states, FAB behavior, responsive layouts, and long-menu behavior. Ensure order previews communicate status without requiring a tracking screen.
10. **Regression gate:** Run the relevant tests, lint, build, and full suite. Fix regressions before declaring completion. Report exactly what changed, tests run and results, and any deferred work or blocked dependencies.

## Project constraints

- Follow the repository’s contribution instructions and existing conventions.
- Keep changes small and reviewable; one focused change per commit if committing is authorized. Use the project’s required commit identity and run the relevant gates before each commit.
- Keep work isolated as required by the project workflow; do not merge or bypass the adjudicator gate.
- Do not modify `useNIP44DM.js` or gift-wrap behavior.
- Do not alter founder-owned checkout work, including unify-checkout, the BTC-only vendor fix, or ReviewPrompt symmetry, without explicit handoff or sign-off.
- Reuse existing components and source-of-truth state logic when possible. Do not duplicate payment or escrow state machines.
- Do not claim tests passed unless you actually ran them.

Begin by reporting the audit findings and proposed lane order. Then implement the authorized, unblocked work.
