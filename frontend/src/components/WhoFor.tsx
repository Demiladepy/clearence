import './WhoFor.css'

export default function WhoFor() {
  return (
    <section className="band">
      <div className="container who">
        <div className="who-head">
          <div className="eyebrow">§ 05 · Who it is for</div>
          <h2 className="h2">Platforms that must prove it.</h2>
        </div>

        <div className="who-list">
          <div className="who-item who-item-main">
<div className="who-title who-title-main">Licensed fintech apps</div>
            <div className="who-body who-body-main">
              Offer private payments and show your regulator they are safe.
            </div>
          </div>
          <div className="who-item">
            <div className="who-title">Businesses paying in stablecoins</div>
            <div className="who-body">
              Keep competitors from watching your payments.
            </div>
          </div>
          <div className="who-item">
            <div className="who-title">Regulators</div>
            <div className="who-body">
              Get proof the rules were followed, instead of trusting everyone.
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}