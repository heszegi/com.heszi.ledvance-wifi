The missing app for Homey to control LEDVANCE SMART+ Wifi lights

1. You must have a Homey Pro.  

2. Install the Ledvance LEDVANCE SMART+ Wifi app

3. Add your device to the official LEDVANCE mobile app: SMART+ (https://apps.apple.com/hu/app/smart/id1576461012).  

4. Open the device details and note the following information: "MAC Address", "Virtual ID", and "Local Key".  

5. In Homey, click "New Device" and select the "LEDVANCE SMART+ WiFi" app.  

6. Choose your light type.  

7. Select a pairing method:  
   👍 "Auto Discovery": Homey may not always find devices based on their MAC address, but try...
   🫵 "Manual": in this case, you must provide the device's local network IP address
       - The official app usually shows your public IP, which is different  
       - Use your router to find the → Local IP ← based on the device’s MAC address

8. Fill in the required information and add the device.  

9. Enjoy! 🙂