import { Sparkles } from 'lucide-react'
import { ASSISTANT_STARTER_SAMPLES } from '../sample-request/assistantStarterSamples'
import SampleIdeaList from '../sample-request/SampleIdeaList'

// Empty-desk onboarding. Shown in DeskPage's scroll area when the desk feed is
// empty (and read-state is ready). Renders the same ASSISTANT_STARTER_SAMPLES
// the assistant DM zero-state shows, through the same shared SampleIdeaList.
//
// Clicking a row does NOT navigate: it hands the (placeholder-collapsed) body
// up via `onUseSample(text)` so DeskPage prefills the desk composer IN PLACE
// (selecting the assistant as recipient if needed). Hovering hands the flat
// preview up via `onPreviewSample(text)`, which DeskPage forwards to the
// composer as ghost text — the full prompt is previewed in the surface where
// the user will edit it rather than duplicated in a card here.
export default function DeskZeroState({
  onUseSample,
  onPreviewSample,
}: {
  onUseSample: (text: string) => void
  onPreviewSample?: (text: string | null) => void
}) {
  return (
    <div className="md-zero">
      <div className="md-zero-inner">
        <header className="md-zero-head">
          <span className="md-zero-ic">
            <Sparkles size={18} />
          </span>
          <div>
            {/* No blurb under the heading: the rows below already say what they
                are, and the how-to ("hover to preview, click to drop it in")
                is discoverable by doing it. */}
            <h2 className="md-zero-t">Sample project ideas</h2>
          </div>
        </header>

        <SampleIdeaList
          samples={ASSISTANT_STARTER_SAMPLES}
          onUse={onUseSample}
          onPreview={onPreviewSample}
        />
      </div>
    </div>
  )
}
