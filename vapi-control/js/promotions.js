/** The checkbox reads one saved CRM setting. It never stores a per-browser or
 * per-call override, and never retries an uncertain write automatically. */
export function createPromotionController(api, onChange = () => {}) {
  const state = { snapshot: null, loading: true, saving: false, verified: false, error: "", notice: "", warning: false };
  let sequence = 0;
  const changed = () => onChange({ ...state });
  const canChange = () => state.verified && !state.loading && !state.saving && Boolean(state.snapshot && (state.snapshot.configured || state.snapshot.enabled));
  const valid = (value) => value && typeof value.enabled === "boolean" && typeof value.configured === "boolean" && Number.isSafeInteger(value.revision) && value.revision >= 0 && Number.isSafeInteger(value.priceCount) && value.priceCount >= 0;
  async function load({ preserveError = false } = {}) {
    if (state.saving) return false;
    const current = ++sequence;
    state.loading = true;
    state.verified = false;
    if (!preserveError) state.error = "";
    changed();
    try {
      const value = await api.promotions();
      if (current !== sequence) return false;
      if (!valid(value)) throw new Error("Could not confirm the saved discount setting.");
      if (state.snapshot && state.snapshot.revision !== value.revision) { state.notice = ""; state.warning = false; }
      state.snapshot = value;
      state.verified = true;
      return true;
    } catch (error) {
      if (current === sequence) state.error = error?.message || "Could not load discounts. Refresh to retry.";
      return false;
    } finally {
      if (current === sequence) { state.loading = false; changed(); }
    }
  }
  async function change(enabled) {
    if (typeof enabled !== "boolean" || !canChange()) return false;
    if (state.snapshot.enabled === enabled) { changed(); return true; }
    const revision = state.snapshot.revision;
    state.saving = true;
    state.error = "";
    state.notice = "";
    state.warning = false;
    changed();
    try {
      const value = await api.savePromotions(enabled, revision);
      if (!valid(value)) throw new Error("Could not confirm the saved discount setting.");
      state.snapshot = value;
      state.verified = true;
      const failed = (value.live?.failed || 0) + (value.sync?.errors || 0);
      const deliveryKnown = value.live && value.sync;
      state.warning = failed > 0 || !deliveryKnown;
      state.notice = !deliveryKnown
        ? "Setting saved. Delivery to active calls was not confirmed; check the CRM before quoting a price."
        : failed > 0
        ? `Setting saved. Delivery is pending for ${value.live?.failed || 0} active calls and ${value.sync?.errors || 0} assistant updates. Check the CRM before quoting a price.`
        : value.live?.updated > 0
          ? `Saved. ${value.live.updated} active call${value.live.updated === 1 ? "" : "s"} received the updated pricing instructions.`
          : "Saved for new calls. No active call needed an update.";
      return true;
    } catch (error) {
      state.error = error?.message || "Could not confirm the discount change.";
      state.verified = false;
      state.saving = false;
      // A timeout may have occurred after persistence. Read the actual saved
      // flag; do not flip it back or submit a second write on the user's behalf.
      await load({ preserveError: true });
      return false;
    } finally {
      state.saving = false;
      changed();
    }
  }
  return { state, canChange, load, change };
}
