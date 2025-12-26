# Kidletto - Personalized Children's Books Website

A modern, responsive Jekyll website for Kidletto, a personalized children's book service that creates custom stories featuring your child as the hero.

## 🎯 Project Overview

Kidletto is a web platform that enables parents to create personalized children's books by:

1. **Uploading photos** of their child (up to 3 people or animals)
2. **Customizing the story** with child's interests, age, and learning goals
3. **Selecting illustration style** (Pixar, Disney, Anime, Christmas, or Pencil)
4. **Choosing delivery format** (PDF, Print + PDF, or Video + PDF)
5. **Receiving personalized stories** within 30 minutes to 7 days depending on format

## 🚀 Features

### Website Pages

- **Homepage** (`index.md`): Hero section, features overview, and testimonials
- **Story Form** (`form.md`): Comprehensive form with:
  - Child's basic information (name, age, gender, eye color)
  - Interest selection (up to 5 from 12 options)
  - Story elements (villain preference, learning goals)
  - Illustration style selection
  - Photo upload with drag-and-drop support
  - Product format selection with pricing
  - Email capture and consent management
- **About** (`about.md`): Company mission, vision, and values
- **FAQ** (`faq.md`): Comprehensive frequently asked questions
- **Privacy Policy** (`privacy.md`): Data protection and privacy information
- **Terms of Service** (`terms.md`): Legal terms and conditions

### Technical Features

- **Responsive Design**: Mobile-first approach, works on all devices
- **Modern UI**: Gradient backgrounds, smooth transitions, and interactive elements
- **Form Validation**: Client-side validation for all form fields
- **Photo Upload**: Drag-and-drop support with file size validation
- **Interactive Components**: Format selection cards, interest checkboxes, and style previews
- **Accessibility**: Semantic HTML, proper labels, and keyboard navigation

## 🛠️ Technology Stack

- **Static Site Generator**: Jekyll 4.4.1
- **Styling**: SCSS with Minima theme
- **JavaScript**: Vanilla JavaScript for form handling and interactivity
- **Hosting**: GitHub Pages (ready for deployment)

## 📋 Installation & Setup

### Prerequisites

- Ruby 3.0 or higher
- Bundler
- Git

### Local Development

1. **Clone the repository**:
   ```bash
   git clone https://github.com/Alex11832/kidletto-site.git
   cd kidletto-site
   ```

2. **Install dependencies**:
   ```bash
   bundle install
   ```

3. **Build the site**:
   ```bash
   bundle exec jekyll build
   ```

4. **Run development server**:
   ```bash
   bundle exec jekyll serve
   ```

5. **View the site**:
   Open `http://localhost:4000` in your browser

## 📁 Project Structure

```
kidletto-site/
├── _config.yml              # Jekyll configuration
├── _layouts/                # Layout templates (inherited from Minima)
├── assets/
│   └── css/
│       └── style.scss       # Custom styles and SCSS
├── index.md                 # Homepage
├── form.md                  # Story creation form
├── about.md                 # About page
├── faq.md                   # FAQ page
├── privacy.md               # Privacy policy
├── terms.md                 # Terms of service
├── 404.html                 # 404 error page
├── Gemfile                  # Ruby dependencies
├── Gemfile.lock             # Locked dependency versions
└── README.md                # This file
```

## 🎨 Design & Styling

### Color Scheme

- **Primary Color**: `#6B5BFF` (Purple)
- **Secondary Color**: `#FF6B9D` (Pink)
- **Accent Color**: `#FFD700` (Gold)
- **Dark Background**: `#0F0F1E` (Dark Purple)
- **Light Text**: `#FFFFFF` (White)
- **Gray Text**: `#A0A0B0` (Light Gray)

### Key Components

- **Hero Section**: Gradient background with call-to-action button
- **Feature Cards**: Grid layout with icons and descriptions
- **Form Sections**: Organized fieldsets with clear labels
- **Format Selection**: Interactive card-based selection
- **Photo Upload**: Drag-and-drop zone with preview
- **Testimonials**: Dark background with star ratings

## 📝 Form Fields

### Child's Information

- Child's Name (text)
- Age (number, 2-12)
- Gender (radio: Boy, Girl, Other)
- Eye Color (select dropdown)

### Interests & Hobbies

- Checkboxes for 12 different interests (max 5 selections)
- Includes: Dinosaurs, Space, Animals, Sports, Music, Art, Dance, Adventure, Magic, Superheroes, Nature, Cooking

### Story Elements

- Villain preference (radio: Yes with defeat, No, Mild challenges)
- Learning goals (checkboxes, max 3 selections)
- Custom learning goals (textarea)

### Illustration Style

- 5 style options: Pixar, Disney, Anime, Christmas, Pencil
- Interactive card selection with visual feedback

### Photo Upload

- Drag-and-drop support
- File browser fallback
- Support for JPG, PNG, WebP
- Maximum 3 photos, 5MB each
- Photo preview with remove functionality

### Product Format

- PDF Only ($9.99)
- Print + PDF ($34.99)
- Video + PDF ($24.99)

### Contact & Consent

- Email address (required)
- Privacy policy consent (required checkbox)
- Newsletter opt-in (optional checkbox)

## 🔧 Form Handling

The form includes client-side validation and data collection:

```javascript
// Form data structure
{
  childName: string,
  childAge: number,
  childGender: string,
  eyeColor: string,
  interests: array,
  villain: string,
  lessons: array,
  customLessons: string,
  illustrationStyle: string,
  productFormat: string,
  email: string,
  consent: boolean,
  newsletter: boolean,
  photos: number
}
```

**Note**: Currently, form submission logs data to browser console. In production, this should be connected to a backend service for processing orders and generating stories.

## 🚀 Deployment

### GitHub Pages

1. **Enable GitHub Pages**:
   - Go to repository settings
   - Navigate to "Pages" section
   - Select "Deploy from a branch"
   - Choose `master` branch and `/root` folder

2. **Site will be available at**:
   ```
   https://Alex11832.github.io/kidletto-site/
   ```

### Custom Domain

To use a custom domain (e.g., kidletto.com):

1. Add a `CNAME` file to the repository root with your domain name
2. Configure DNS records to point to GitHub Pages
3. Enable HTTPS in repository settings

## 📱 Responsive Breakpoints

- **Mobile**: < 768px
- **Tablet**: 768px - 1024px
- **Desktop**: > 1024px

## ✅ Browser Support

- Chrome (latest)
- Firefox (latest)
- Safari (latest)
- Edge (latest)
- Mobile browsers (iOS Safari, Chrome Mobile)

## 🔐 Security & Privacy

- All forms use HTTPS in production
- Photo uploads are validated client-side
- Privacy policy included and linked
- Terms of service included and linked
- GDPR-compliant consent checkboxes

## 📚 Content Pages

### Privacy Policy

Comprehensive privacy policy covering:
- Data collection practices
- Photo usage and storage
- Third-party services
- User rights and data retention
- Contact information

### Terms of Service

Legal terms including:
- Use license and restrictions
- Disclaimer of warranties
- Limitation of liability
- Photo usage rights
- Refund policy
- Contact information

### FAQ

Common questions covering:
- How personalization works
- Photo safety
- Delivery timelines
- Photo upload limits
- Illustration styles
- Age appropriateness
- Customization options
- Payment methods
- Refund policy
- Support contact

## 🎯 Future Enhancements

Potential features for future development:

1. **Backend Integration**:
   - Connect form to order processing system
   - Implement payment gateway (Stripe, PayPal)
   - AI story generation integration
   - Photo processing and illustration generation

2. **User Accounts**:
   - User registration and login
   - Order history and tracking
   - Saved preferences
   - Download history

3. **Advanced Features**:
   - Story preview before purchase
   - Multiple story templates
   - Customizable story length
   - Additional illustration styles
   - Video generation integration

4. **Marketing**:
   - Email marketing integration
   - Social media sharing
   - Referral program
   - Blog section

5. **Analytics**:
   - Google Analytics integration
   - Conversion tracking
   - User behavior analysis

## 📞 Support

For questions or issues:

- **Email**: support@kidletto.com
- **GitHub Issues**: [Create an issue](https://github.com/Alex11832/kidletto-site/issues)

## 📄 License

This project is proprietary and confidential. All rights reserved.

## 👥 Contributing

This is a proprietary project. External contributions are not accepted at this time.

## 🙏 Acknowledgments

- Inspired by competitor sites: DreamStories.ai, imagitime.com, mycustomkidsbooks.com, storyspark.ai, hoorayheroes.com, magicalchildrensbook.com
- Built with Jekyll and the Minima theme
- Icons and emojis used throughout the site

---

**Last Updated**: December 25, 2025

**Repository**: [https://github.com/Alex11832/kidletto-site](https://github.com/Alex11832/kidletto-site)
