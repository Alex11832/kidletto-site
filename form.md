---
layout: default
title: Create Your Story - Kidletto
---

<div class="form-section" id="form-section">
  <h2 class="section-title">Create Your Personalized Story</h2>
  
  <div class="form-container">
    <form id="storyForm" onsubmit="handleFormSubmit(event)">
      
      <!-- Child's Basic Information -->
      <fieldset>
        <legend style="font-size: 1.2rem; font-weight: 600; color: #6B5BFF; margin-bottom: 20px;">Child's Information</legend>
        
        <div class="form-group">
          <label for="childName">Child's Name *</label>
          <input type="text" id="childName" name="childName" required placeholder="e.g., Emma">
          <div class="help-text">The main character of your story</div>
        </div>

        <div class="form-group">
          <label for="childAge">Age *</label>
          <input type="number" id="childAge" name="childAge" min="2" max="12" required placeholder="e.g., 5">
          <div class="help-text">Stories are tailored for ages 2-12</div>
        </div>

        <div class="form-group">
          <label>Gender *</label>
          <div class="radio-group">
            <label><input type="radio" name="childGender" value="boy" required> Boy</label>
            <label><input type="radio" name="childGender" value="girl" required> Girl</label>
            <label><input type="radio" name="childGender" value="other" required> Other</label>
          </div>
        </div>

        <div class="form-group">
          <label>Eye Color *</label>
          <select name="eyeColor" required>
            <option value="">Select eye color...</option>
            <option value="blue">Blue</option>
            <option value="brown">Brown</option>
            <option value="green">Green</option>
            <option value="hazel">Hazel</option>
            <option value="gray">Gray</option>
            <option value="black">Black</option>
            <option value="amber">Amber</option>
          </select>
        </div>
      </fieldset>

      <!-- Interests -->
      <fieldset style="margin-top: 30px;">
        <legend style="font-size: 1.2rem; font-weight: 600; color: #6B5BFF; margin-bottom: 20px;">Interests & Hobbies</legend>
        
        <div class="form-group">
          <label>What are your child's interests? * (Select up to 5)</label>
          <div class="checkbox-group">
            <label><input type="checkbox" name="interests" value="dinosaurs"> 🦕 Dinosaurs</label>
            <label><input type="checkbox" name="interests" value="space"> 🚀 Space & Astronauts</label>
            <label><input type="checkbox" name="interests" value="animals"> 🦁 Animals & Wildlife</label>
            <label><input type="checkbox" name="interests" value="sports"> ⚽ Sports</label>
            <label><input type="checkbox" name="interests" value="music"> 🎵 Music & Singing</label>
            <label><input type="checkbox" name="interests" value="art"> 🎨 Art & Drawing</label>
            <label><input type="checkbox" name="interests" value="dance"> 💃 Dance & Movement</label>
            <label><input type="checkbox" name="interests" value="adventure"> 🏔️ Adventure & Exploration</label>
            <label><input type="checkbox" name="interests" value="magic"> ✨ Magic & Fantasy</label>
            <label><input type="checkbox" name="interests" value="superheroes"> 🦸 Superheroes</label>
            <label><input type="checkbox" name="interests" value="nature"> 🌿 Nature & Gardening</label>
            <label><input type="checkbox" name="interests" value="cooking"> 👨‍🍳 Cooking & Baking</label>
          </div>
          <div class="help-text">These will be woven into your story</div>
        </div>
      </fieldset>

      <!-- Story Elements -->
      <fieldset style="margin-top: 30px;">
        <legend style="font-size: 1.2rem; font-weight: 600; color: #6B5BFF; margin-bottom: 20px;">Story Elements</legend>
        
        <div class="form-group">
          <label>Should the story include a villain? *</label>
          <div class="radio-group">
            <label><input type="radio" name="villain" value="yes" required> Yes, with a villain to defeat through kindness</label>
            <label><input type="radio" name="villain" value="no" required> No, keep it purely positive</label>
            <label><input type="radio" name="villain" value="mild" required> Mild challenges, no real villain</label>
          </div>
        </div>

        <div class="form-group">
          <label>What should your child learn from this story? * (Select up to 3)</label>
          <div class="checkbox-group">
            <label><input type="checkbox" name="lessons" value="kindness"> 💚 Kindness & Compassion</label>
            <label><input type="checkbox" name="lessons" value="courage"> 💪 Courage & Bravery</label>
            <label><input type="checkbox" name="lessons" value="friendship"> 👫 Friendship & Teamwork</label>
            <label><input type="checkbox" name="lessons" value="creativity"> 🎭 Creativity & Imagination</label>
            <label><input type="checkbox" name="lessons" value="perseverance"> 🏃 Perseverance & Trying Hard</label>
            <label><input type="checkbox" name="lessons" value="honesty"> 🤝 Honesty & Integrity</label>
            <label><input type="checkbox" name="lessons" value="confidence"> 🌟 Confidence & Self-Worth</label>
            <label><input type="checkbox" name="lessons" value="curiosity"> 🔍 Curiosity & Learning</label>
          </div>
          <div class="help-text">Or write your own learning goals below</div>
        </div>

        <div class="form-group">
          <label for="customLessons">Custom Learning Goals (Optional)</label>
          <textarea id="customLessons" name="customLessons" placeholder="e.g., Learning to share toys, dealing with fears, making new friends..."></textarea>
        </div>
      </fieldset>

      <!-- Illustration Style -->
      <fieldset style="margin-top: 30px;">
        <legend style="font-size: 1.2rem; font-weight: 600; color: #6B5BFF; margin-bottom: 20px;">Illustration Style</legend>
        
        <div class="form-group">
          <label>Choose your preferred illustration style: *</label>
          <div class="format-selection">
            <div class="format-options">
              <div class="format-card" onclick="selectStyle('pixar', this)">
                <input type="radio" name="illustrationStyle" value="pixar" required>
                <div class="format-icon">🎬</div>
                <div class="format-name">Pixar</div>
                <div class="format-desc">Modern, vibrant 3D animation style</div>
              </div>
              <div class="format-card" onclick="selectStyle('disney', this)">
                <input type="radio" name="illustrationStyle" value="disney" required>
                <div class="format-icon">👑</div>
                <div class="format-name">Disney</div>
                <div class="format-desc">Classic, magical storybook style</div>
              </div>
              <div class="format-card" onclick="selectStyle('anime', this)">
                <input type="radio" name="illustrationStyle" value="anime" required>
                <div class="format-icon">🎨</div>
                <div class="format-name">Anime</div>
                <div class="format-desc">Colorful, expressive Japanese style</div>
              </div>
              <div class="format-card" onclick="selectStyle('christmas', this)">
                <input type="radio" name="illustrationStyle" value="christmas" required>
                <div class="format-icon">🎄</div>
                <div class="format-name">Christmas</div>
                <div class="format-desc">Festive, holiday-themed illustrations</div>
              </div>
              <div class="format-card" onclick="selectStyle('pencil', this)">
                <input type="radio" name="illustrationStyle" value="pencil" required>
                <div class="format-icon">✏️</div>
                <div class="format-name">Pencil</div>
                <div class="format-desc">Artistic, hand-drawn pencil style</div>
              </div>
            </div>
          </div>
        </div>
      </fieldset>

      <!-- Photo Upload (moved to next section) -->
      <fieldset style="margin-top: 30px;">
        <legend style="font-size: 1.2rem; font-weight: 600; color: #6B5BFF; margin-bottom: 20px;">Upload Photos</legend>
        
        <div class="form-group">
          <label>Upload your child's photo (and up to 2 more people/animals) *</label>
          <div class="photo-upload" id="photoUpload" ondrop="handleDrop(event)" ondragover="handleDragOver(event)" ondragleave="handleDragLeave(event)">
            <div class="upload-icon">📸</div>
            <p>Drag and drop photos here or click to browse</p>
            <button type="button" class="upload-btn" onclick="document.getElementById('photoInput').click()">Choose Photos</button>
            <input type="file" id="photoInput" class="file-input" multiple accept="image/*" onchange="handlePhotoUpload(event)">
          </div>
          <div class="help-text">Supported formats: JPG, PNG, WebP (up to 3 photos, 5MB each)</div>
          <div class="photo-preview" id="photoPreview"></div>
        </div>
      </fieldset>

      <!-- Product Format -->
      <fieldset style="margin-top: 30px;">
        <legend style="font-size: 1.2rem; font-weight: 600; color: #6B5BFF; margin-bottom: 20px;">Choose Your Format</legend>
        
        <div class="form-group">
          <label>Select how you'd like to receive your story: *</label>
          <div class="format-selection">
            <div class="format-options">
              <div class="format-card" onclick="selectFormat('pdf', this)">
                <input type="radio" name="productFormat" value="pdf" required>
                <div class="format-icon">📄</div>
                <div class="format-name">PDF Only</div>
                <div class="format-price">$9.99</div>
                <div class="format-desc">Digital download, instant access</div>
              </div>
              <div class="format-card" onclick="selectFormat('print', this)">
                <input type="radio" name="productFormat" value="print" required>
                <div class="format-icon">📚</div>
                <div class="format-name">Print + PDF</div>
                <div class="format-price">$34.99</div>
                <div class="format-desc">Hardcover book + digital copy</div>
              </div>
              <div class="format-card" onclick="selectFormat('video', this)">
                <input type="radio" name="productFormat" value="video" required>
                <div class="format-icon">🎬</div>
                <div class="format-name">Video + PDF</div>
                <div class="format-price">$24.99</div>
                <div class="format-desc">Animated story + PDF</div>
              </div>
            </div>
          </div>
        </div>
      </fieldset>

      <!-- Email & Consent -->
      <fieldset style="margin-top: 30px;">
        <legend style="font-size: 1.2rem; font-weight: 600; color: #6B5BFF; margin-bottom: 20px;">Contact & Consent</legend>
        
        <div class="form-group">
          <label for="email">Email Address *</label>
          <input type="email" id="email" name="email" required placeholder="your@email.com">
          <div class="help-text">We'll send your story download link here</div>
        </div>

        <div class="consent-checkbox">
          <input type="checkbox" id="consent" name="consent" required>
          <label for="consent">
            I agree to the <a href="/privacy.html" target="_blank">Privacy Policy</a> and consent to the processing of my personal data, including photos for story personalization.
          </label>
        </div>

        <div class="consent-checkbox">
          <input type="checkbox" id="newsletter" name="newsletter">
          <label for="newsletter">
            Send me updates about new story themes and special offers
          </label>
        </div>
      </fieldset>

      <!-- Submit Button -->
      <button type="submit" class="submit-btn">Create My Story 🚀</button>
      
      <p style="text-align: center; margin-top: 20px; color: #A0A0B0; font-size: 0.9rem;">
        ✓ Your story will be ready in 30 minutes<br>
        ✓ High-quality illustrations included<br>
        ✓ Secure payment processing
      </p>

    </form>
  </div>
</div>

<script>
// Store uploaded photos
let uploadedPhotos = [];

// Handle photo upload
function handlePhotoUpload(event) {
  const files = Array.from(event.target.files);
  
  if (uploadedPhotos.length + files.length > 3) {
    alert('You can upload a maximum of 3 photos');
    return;
  }

  files.forEach(file => {
    if (file.size > 5 * 1024 * 1024) {
      alert(`${file.name} is too large. Maximum size is 5MB.`);
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      uploadedPhotos.push({
        name: file.name,
        data: e.target.result
      });
      renderPhotoPreview();
    };
    reader.readAsDataURL(file);
  });
}

// Render photo preview
function renderPhotoPreview() {
  const preview = document.getElementById('photoPreview');
  preview.innerHTML = '';

  uploadedPhotos.forEach((photo, index) => {
    const div = document.createElement('div');
    div.className = 'preview-item';
    div.innerHTML = `
      <img src="${photo.data}" alt="Preview ${index + 1}">
      <button type="button" class="remove-btn" onclick="removePhoto(${index})">×</button>
    `;
    preview.appendChild(div);
  });
}

// Remove photo
function removePhoto(index) {
  uploadedPhotos.splice(index, 1);
  renderPhotoPreview();
}

// Drag and drop handlers
function handleDragOver(event) {
  event.preventDefault();
  document.getElementById('photoUpload').classList.add('dragover');
}

function handleDragLeave(event) {
  document.getElementById('photoUpload').classList.remove('dragover');
}

function handleDrop(event) {
  event.preventDefault();
  document.getElementById('photoUpload').classList.remove('dragover');
  
  const files = event.dataTransfer.files;
  document.getElementById('photoInput').files = files;
  handlePhotoUpload({ target: { files: files } });
}

// Select illustration style
function selectStyle(style, element) {
  document.querySelectorAll('.format-options .format-card').forEach(card => {
    card.classList.remove('selected');
  });
  element.classList.add('selected');
  element.querySelector('input[type="radio"]').checked = true;
}

// Select product format
function selectFormat(format, element) {
  document.querySelectorAll('.format-options .format-card').forEach(card => {
    card.classList.remove('selected');
  });
  element.classList.add('selected');
  element.querySelector('input[type="radio"]').checked = true;
}

// Form submission
function handleFormSubmit(event) {
  event.preventDefault();

  // Validate photos
  if (uploadedPhotos.length === 0) {
    alert('Please upload at least one photo');
    return;
  }

  // Validate interests
  const interests = document.querySelectorAll('input[name="interests"]:checked');
  if (interests.length === 0) {
    alert('Please select at least one interest');
    return;
  }

  // Validate lessons
  const lessons = document.querySelectorAll('input[name="lessons"]:checked');
  if (lessons.length === 0 && !document.getElementById('customLessons').value) {
    alert('Please select learning goals or write custom ones');
    return;
  }

  // Collect form data
  const formData = new FormData(event.target);
  const data = {
    childName: formData.get('childName'),
    childAge: formData.get('childAge'),
    childGender: formData.get('childGender'),
    eyeColor: formData.get('eyeColor'),
    interests: Array.from(interests).map(i => i.value),
    villain: formData.get('villain'),
    lessons: Array.from(lessons).map(l => l.value),
    customLessons: formData.get('customLessons'),
    illustrationStyle: formData.get('illustrationStyle'),
    productFormat: formData.get('productFormat'),
    email: formData.get('email'),
    consent: formData.get('consent') === 'on',
    newsletter: formData.get('newsletter') === 'on',
    photos: uploadedPhotos.length
  };

  // Log data (in production, this would send to backend)
  console.log('Form submitted:', data);
  
  // Show success message
  alert(`Thank you! Your story request has been received.\n\nWe'll send a confirmation email to ${data.email} with your story within 30 minutes.`);
  
  // Reset form
  event.target.reset();
  uploadedPhotos = [];
  renderPhotoPreview();
}

// Limit interest selection to 5
document.addEventListener('change', function(e) {
  if (e.target.name === 'interests') {
    const checked = document.querySelectorAll('input[name="interests"]:checked');
    if (checked.length > 5) {
      e.target.checked = false;
      alert('You can select up to 5 interests');
    }
  }
  
  if (e.target.name === 'lessons') {
    const checked = document.querySelectorAll('input[name="lessons"]:checked');
    if (checked.length > 3) {
      e.target.checked = false;
      alert('You can select up to 3 learning goals');
    }
  }
});
</script>
