import { Suspense } from "react";
import { DiscussionPrototype } from "@/app/prototype/discussion/discussion-prototype";

export default function DiscussionPrototypePage() {
  return (
    <Suspense fallback={<div className="empty-state">Loading prototype</div>}>
      <DiscussionPrototype />
    </Suspense>
  );
}
