// DRAFT legal pages, pending review by Nextrium's lawyer before public launch.

const DraftNote = () => (
  <p className="draft">
    Draft for the private beta, last updated 29 September 2026 (rev. 4). Questions: legal@showrium.com.
  </p>
);

export function Privacy() {
  return (
    <article className="legal">
      <h1>Privacy policy</h1>
      <DraftNote />
      <p>
        Showrium is operated by Nextrium, a company registered in Nigeria ("we"). This policy explains what we collect,
        why, and your choices. It applies to showrium.com, the Showrium apps and the Showrium API.
      </p>

      <h2>What we collect</h2>
      <ul>
        <li><strong>Waitlist:</strong> if you join the waitlist, just your email address, used only to send your invite and product updates you can opt out of.</li>
        <li><strong>Account details:</strong> name, email, profile picture and sign-in method.</li>
        <li><strong>Content you give us:</strong> text, voice notes, links, repositories, feeds, photos and documents you upload or connect, your answers to the daily question, plus the drafts and images we create with you.</li>
        <li><strong>Sign-in and connected accounts:</strong> access tokens from GitHub, Google or social platforms, stored encrypted, and the posts, comments and statistics those platforms let us read.</li>
        <li><strong>Email:</strong> the messages we send you (confirming your email, resetting your password, invites) and whether they were delivered.</li>
        <li><strong>Usage and billing:</strong> actions in the app, credit balance and transactions, and payment records from our payment providers. We never see or store full card numbers.</li>
      </ul>

      <h2>How we use it</h2>
      <ul>
        <li>To create, schedule and publish content when you ask us to.</li>
        <li>To learn your voice and interests <em>for your account only</em>. We don't use your content to train AI models shared with other customers.</li>
        <li>To find an image for a post: your own photo, the preview image of a link you shared, a screenshot of that page, or, if you allow it, an AI-made image that is always labelled as AI.</li>
        <li>To run, secure and improve the service, prevent abuse, and meet legal duties.</li>
      </ul>

      <h2>Who processes it</h2>
      <p>
        We use service providers that process data for us under contract: Cloudflare (hosting, database, file storage,
        page screenshots and some AI models), AI model providers reached through OpenRouter (to write drafts), Brevo (to
        send account emails), and our payment processors Paystack and Lemon Squeezy. Social platforms receive only the
        content you choose to publish. We don't sell personal data or share it for advertising.
      </p>

      <h2>Where it's stored and for how long</h2>
      <p>
        Data is stored on Cloudflare's global network and may be processed outside Nigeria, with safeguards required by
        the Nigeria Data Protection Act 2023 and, for users in the EU/UK, the GDPR. Your files and images are private: only
        members of your workspace can see them. We keep account data while your account is open. You can delete your
        account yourself in Settings → Your data: your account, and every workspace where you're the only member, are
        deleted at once with their posts, files and connected accounts. Backups roll over within 30 days. Payment
        records are kept by our payment processors for as long as tax law requires; we keep only the event type, not
        your name or email.
      </p>

      <h2>Your rights</h2>
      <p>
        You can access, correct, export or delete your data, withdraw consent, and disconnect any social account at any
        time. Download a copy or delete your account in Settings → Your data, or email legal@showrium.com. You may also complain to the Nigeria Data Protection Commission or your local
        data protection authority.
      </p>
    </article>
  );
}

export function Terms() {
  return (
    <article className="legal">
      <h1>Terms of service</h1>
      <DraftNote />
      <p>
        These terms are an agreement between you and Nextrium, a company registered in Nigeria, for your use of Showrium.
        Showrium is in beta: features may change and the service may be interrupted.
      </p>

      <h2>Your content and accounts</h2>
      <ul>
        <li>You own the content you give us and the posts we help you create. You give us permission to process it only to provide the service.</li>
        <li>You're responsible for what you publish and for following each platform's rules.</li>
        <li>Keep your API keys secret. Activity with your keys counts as yours.</li>
      </ul>

      <h2>What you must not do</h2>
      <ul>
        <li>Spam, fake engagement, or automated replies, follows or messages.</li>
        <li>Impersonate anyone, or create AI likenesses or voices of anyone but yourself.</li>
        <li>Publish unlawful, deceptive or harmful content, or hide that realistic content was made with AI where the law or a platform requires it.</li>
        <li>Attack, overload or reverse-engineer the service.</li>
      </ul>

      <h2>Plans and credits</h2>
      <p>
        Paid plans and credits are described at purchase. Credits are charged only when an action succeeds. Purchases
        through app stores follow that store's refund rules.
      </p>

      <h2>Liability</h2>
      <p>
        The service is provided "as is" during the beta. To the extent the law allows, our total liability is limited to
        the amount you paid us in the 12 months before the claim. These terms are governed by the laws of the Federal
        Republic of Nigeria.
      </p>

      <h2>Contact</h2>
      <p>support@showrium.com for help, legal@showrium.com for legal questions.</p>
    </article>
  );
}
